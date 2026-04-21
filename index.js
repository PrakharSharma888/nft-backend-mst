import dotenv from 'dotenv'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import { ethers } from 'ethers'

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

const upload = multer({ storage: multer.memoryStorage() })

// Load .env reliably (works even if process CWD is different)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
dotenv.config({ path: path.resolve(process.cwd(), '.env') })
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

function getPinataJwt() {
  return (process.env.PINATA_JWT || '').trim()
}

function getGatewayBase() {
  const v = (process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs/').trim()
  return v.endsWith('/') ? v : `${v}/`
}

function requireJwt() {
  if (!getPinataJwt()) {
    const err = new Error('Missing PINATA_JWT in server environment')
    err.statusCode = 500
    throw err
  }
}

async function pinFileToPinata({ fileBuffer, fileName, contentType }) {
  requireJwt()

  const form = new FormData()
  form.append('file', new Blob([fileBuffer], { type: contentType || 'application/octet-stream' }), fileName)

  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getPinataJwt()}` },
    body: form,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Pinata pinFileToIPFS failed: ${res.status} ${text}`)
  }

  return await res.json()
}

async function pinJsonToPinata({ name, description, image, attributes }) {
  requireJwt()

  // Pinata expects `pinataContent` (NFT metadata lives inside it)
  const payload = {
    pinataContent: {
      name,
      description,
      image,
      attributes: Array.isArray(attributes) ? attributes : [],
    },
    pinataMetadata: { name: 'certificate-metadata.json' },
    pinataOptions: { cidVersion: 1 },
  }

  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getPinataJwt()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Pinata pinJSONToIPFS failed: ${res.status} ${text}`)
  }

  return await res.json()
}

const MINT_ABI = [
  'function mintWorkshopCertificate(uint256,string,string,string,string) external returns (uint256)',
]

function extractRevertReason(err) {
  if (!err) return 'Unknown error'
  if (typeof err.reason === 'string' && err.reason.length > 0) return err.reason
  const m = `${err.shortMessage || ''} ${err.message || ''}`.trim()
  if (m) return m
  return 'Transaction would revert (node did not return a reason)'
}

function getChainRpcUrl() {
  return (process.env.VITE_RPC_URL || process.env.MST_RPC_URL || '').trim()
}

function getChainIdNumber() {
  const raw = process.env.VITE_CHAIN_ID
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
  const n = Number(String(raw).trim())
  return Number.isFinite(n) ? n : undefined
}

/** Simulate mint + estimate gas on the canonical RPC (same as .env), not MetaMask’s injected node. */
app.post('/api/chain/prepare-mint', async (req, res) => {
  try {
    const rpc = getChainRpcUrl()
    if (!rpc) {
      return res.status(500).json({ ok: false, reason: 'Missing VITE_RPC_URL (or MST_RPC_URL) in .env for server-side mint checks.' })
    }

    const { contractAddress, from, eventId, studentName, mobileNumber, branch, tokenURI } = req.body || {}
    if (!contractAddress || !from || eventId === undefined || eventId === null || !studentName || !mobileNumber || !branch || !tokenURI) {
      return res
        .status(400)
        .json({ ok: false, reason: 'Missing contractAddress/from/eventId/studentName/mobileNumber/branch/tokenURI' })
    }

    const chainId = getChainIdNumber()
    const provider =
      chainId !== undefined ? new ethers.JsonRpcProvider(rpc, chainId) : new ethers.JsonRpcProvider(rpc)
    const addr = ethers.getAddress(contractAddress)
    const fromAddr = ethers.getAddress(from)

    const code = await provider.getCode(addr)
    if (!code || code === '0x') {
      return res.json({
        ok: false,
        reason:
          'No contract code at this address on the RPC in .env. Fix VITE_CONTRACT_ADDRESS or point MetaMask + .env to the same MST Testnet RPC.',
      })
    }

    const contract = new ethers.Contract(addr, MINT_ABI, provider)
    const args = [
      BigInt(eventId),
      String(studentName).trim(),
      String(mobileNumber).trim(),
      String(branch).trim(),
      String(tokenURI).trim(),
    ]

    try {
      await contract.mintWorkshopCertificate.staticCall(...args, { from: fromAddr })
    } catch (e) {
      return res.json({ ok: false, reason: extractRevertReason(e) })
    }

    let gas
    try {
      gas = await contract.mintWorkshopCertificate.estimateGas(...args, { from: fromAddr })
    } catch {
      gas = 600000n
    }

    const padded = (gas * 145n) / 100n + 80_000n
    const gasLimit = padded > 1_500_000n ? 1_500_000n : padded < 450_000n ? 450_000n : padded

    res.json({ ok: true, gasLimit: gasLimit.toString() })
  } catch (e) {
    res.status(500).json({ ok: false, reason: e?.message || 'prepare-mint failed' })
  }
})

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasPinataJwt: !!getPinataJwt(),
    hasChainRpc: !!getChainRpcUrl(),
    routes: ['/api/health', '/api/chain/prepare-mint', '/api/ipfs/certificate', '/api/ipfs/metadata'],
  })
})

// Upload rendered certificate image (PNG/JPG) to IPFS
app.post('/api/ipfs/certificate', upload.single('file'), async (req, res) => {
  try {
    const f = req.file
    if (!f) return res.status(400).json({ error: 'Missing file' })

    const pinned = await pinFileToPinata({
      fileBuffer: f.buffer,
      fileName: f.originalname || 'certificate.png',
      contentType: f.mimetype,
    })

    const ipfsHash = pinned.IpfsHash
    const gateway = getGatewayBase()
    res.json({
      ipfsHash,
      ipfsUri: `ipfs://${ipfsHash}`,
      gatewayUrl: `${gateway}${ipfsHash}`,
    })
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Upload failed' })
  }
})

// Upload NFT metadata JSON to IPFS
app.post('/api/ipfs/metadata', async (req, res) => {
  try {
    const { name, description, image, attributes } = req.body || {}
    if (!name || !description || !image) {
      return res.status(400).json({ error: 'Missing name/description/image' })
    }

    const pinned = await pinJsonToPinata({
      name,
      description,
      image,
      attributes: Array.isArray(attributes) ? attributes : [],
    })

    const ipfsHash = pinned.IpfsHash
    const gateway = getGatewayBase()
    res.json({
      ipfsHash,
      ipfsUri: `ipfs://${ipfsHash}`,
      gatewayUrl: `${gateway}${ipfsHash}`,
    })
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Upload failed' })
  }
})

// Default 5190: Vite often grabs 5173–5178+ when those ports are busy; keep API off that range.
const port = Number(process.env.PORT || 5190)
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`IPFS backend listening on http://localhost:${port}`)
})

