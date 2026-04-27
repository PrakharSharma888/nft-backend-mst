const dotenv = require('dotenv')
const cors = require('cors')
const express = require('express')
const multer = require('multer')
const path = require('path')
const { ethers } = require('ethers')

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

const upload = multer({ storage: multer.memoryStorage() })

// Load .env reliably
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
    throw new Error('Missing PINATA_JWT in server environment')
  }
}

async function pinFileToPinata({ fileBuffer, fileName, contentType }) {
  requireJwt()

  const form = new FormData()
  form.append(
    'file',
    new Blob([fileBuffer], {
      type: contentType || 'application/octet-stream',
    }),
    fileName
  )

  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getPinataJwt()}`,
    },
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

  const payload = {
    pinataContent: {
      name,
      description,
      image,
      attributes: Array.isArray(attributes) ? attributes : [],
    },
    pinataMetadata: {
      name: 'certificate-metadata.json',
    },
    pinataOptions: {
      cidVersion: 1,
    },
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

// MUST match your smart contract exactly
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
  if (!raw) return undefined

  const n = Number(String(raw).trim())
  return Number.isFinite(n) ? n : undefined
}

/**
 * PREPARE MINT
 */
app.post('/api/chain/prepare-mint', async (req, res) => {
  try {
    const rpc = getChainRpcUrl()

    if (!rpc) {
      return res.status(500).json({
        ok: false,
        reason: 'Missing VITE_RPC_URL in .env',
      })
    }

    const {
      contractAddress,
      from,
      eventId,
      studentName,
      mobileNumber,
      branch,
      tokenURI,
    } = req.body || {}

    if (
      !contractAddress ||
      !from ||
      eventId === undefined ||
      !studentName ||
      !mobileNumber ||
      !branch ||
      !tokenURI
    ) {
      return res.status(400).json({
        ok: false,
        reason: 'Missing required mint fields',
      })
    }

    const chainId = getChainIdNumber()

    const provider =
      chainId !== undefined
        ? new ethers.JsonRpcProvider(rpc, chainId)
        : new ethers.JsonRpcProvider(rpc)

    const contract = new ethers.Contract(
      contractAddress,
      MINT_ABI,
      provider
    )

    const args = [
      BigInt(eventId),
      String(studentName).trim(),
      String(mobileNumber).trim(),
      String(branch).trim(),
      String(tokenURI).trim(),
    ]

    try {
      await contract.mintWorkshopCertificate.staticCall(...args, {
        from,
      })
    } catch (e) {
      return res.json({
        ok: false,
        reason: extractRevertReason(e),
      })
    }

    let gas

    try {
      gas = await contract.mintWorkshopCertificate.estimateGas(...args, {
        from,
      })
    } catch {
      gas = 600000n
    }

    const padded = (gas * 145n) / 100n + 80000n

    res.json({
      ok: true,
      gasLimit: padded.toString(),
    })
  } catch (e) {
    res.status(500).json({
      ok: false,
      reason: e?.message || 'prepare-mint failed',
    })
  }
})

/**
 * HEALTH CHECK
 */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasPinataJwt: !!getPinataJwt(),
    hasChainRpc: !!getChainRpcUrl(),
  })
})

/**
 * UPLOAD CERTIFICATE IMAGE TO IPFS
 */
app.post('/api/ipfs/certificate', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'Missing file',
      })
    }

    const pinned = await pinFileToPinata({
      fileBuffer: req.file.buffer,
      fileName: req.file.originalname || 'certificate.png',
      contentType: req.file.mimetype,
    })

    const ipfsHash = pinned.IpfsHash
    const gateway = getGatewayBase()

    res.json({
      ipfsHash,
      ipfsUri: `ipfs://${ipfsHash}`,
      gatewayUrl: `${gateway}${ipfsHash}`,
    })
  } catch (e) {
    res.status(500).json({
      error: e?.message || 'Upload failed',
    })
  }
})

/**
 * UPLOAD METADATA TO IPFS
 */
app.post('/api/ipfs/metadata', async (req, res) => {
  try {
    const { name, description, image, attributes } = req.body || {}

    if (!name || !description || !image) {
      return res.status(400).json({
        error: 'Missing name/description/image',
      })
    }

    const pinned = await pinJsonToPinata({
      name,
      description,
      image,
      attributes,
    })

    const ipfsHash = pinned.IpfsHash
    const gateway = getGatewayBase()

    res.json({
      ipfsHash,
      ipfsUri: `ipfs://${ipfsHash}`,
      gatewayUrl: `${gateway}${ipfsHash}`,
    })
  } catch (e) {
    res.status(500).json({
      error: e?.message || 'Upload failed',
    })
  }
})

const port = Number(process.env.PORT || 5190)

app.listen(port, () => {
  console.log(`IPFS backend listening on http://localhost:${port}`)
})