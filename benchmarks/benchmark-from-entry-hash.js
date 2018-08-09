'use strict'

const Log = require('../src/log')
const Keystore = require('orbit-db-keystore')
const EntryIO = require('../src/entry-io')
const IPFS = require('ipfs')
const IPFSRepo = require('ipfs-repo')
const DatastoreLevel = require('datastore-level')

const { ACL, Identity, IdentityProvider } = Log

// State
let ipfs
let log

// Metrics
let totalLoaded = 0
let seconds = 0
let entriesLoadedPerSecond = 0
let lastTenSeconds = 0
let total = 0

let run = (() => {
  console.log('Starting benchmark...')

  const repoConf = {
    storageBackends: {
      blocks: DatastoreLevel
    }
  }

  ipfs = new IPFS({
    repo: new IPFSRepo('./ipfs-log-benchmarks/fromEntryHash/ipfs', repoConf),
    start: false,
    EXPERIMENTAL: {
      pubsub: false,
      sharding: false,
      dht: false
    }
  })

  ipfs.on('error', (err) => {
    console.error(err)
  })

  ipfs.on('ready', async () => {
    // Create a log
    const keystore = Keystore.create('./test-keys')
    const key = keystore.createKey('benchmark-from-entry-hash')
    const provider = new IdentityProvider(
      data => keystore.sign(key, data),
      async (sig, entryKey, data) =>  {
        const pubKey = await keystore.importPublicKey(entryKey)
        return keystore.verify(sig, pubKey, data)
      }
    )
    const acl = new ACL((pubKey, entry) => Promise.resolve(pubKey === key.getPublic('hex')))
    const identity = new Identity(
      key.getPublic('hex'),
      key.getPublic('hex'),
      provider
    )

    log = new Log(ipfs, 'A', null, null, null, acl, identity)

    const count = parseInt(process.argv[2]) || 50000
    const refCount = 64
    const concurrency = 128
    const delay = 0

    console.log("Creating a log...")

    const st = new Date().getTime()

    try {
      for (let i = 1; i < count + 1; i ++) {
        await log.append('hello' + i, refCount)
        process.stdout.write("\rWriting " + i + " / " + count)
      }
      const dt1 = new Date().getTime()
      process.stdout.write(" (" + (dt1 - st) + " ms)\n")
    } catch (e) {
      console.log(e)
    }

    const onDataUpdated = (hash, entry, resultLength, result, queue) => {
      entriesLoadedPerSecond++
      lastTenSeconds++
      total = resultLength
      process.stdout.write("\rLoading " + total + " / " + count)
    }

    const outputMetrics = () => {
      totalLoaded = total - totalLoaded
      seconds++
      if (seconds % 10 === 0) {
        console.log(`--> Average of ${lastTenSeconds / 10} e/s in the last 10 seconds`)
        if (lastTenSeconds === 0) throw new Error('Problems!')
        lastTenSeconds = 0
      }
      console.log(`\n${entriesLoadedPerSecond} entries loaded per second, ${totalLoaded} loaded in ${seconds} seconds (Entry count: ${total})`)
      entriesLoadedPerSecond = 0
    }

    // Output metrics at 1 second interval
    setInterval(outputMetrics, 1000)

    const dt2 = new Date().getTime()

    if (global.gc) {
      global.gc()
    } else {
      console.warn('Start benchmark with --expose-gc flag');
    }

    const m1 = process.memoryUsage()

    const result = await Log.fromEntryHash(
      ipfs,
      log.heads.map(e => e.hash),
      log._id,
      -1,
      [],
      log._acl,
      log._identity,
      onDataUpdated
    )

    outputMetrics()
    const et = new Date().getTime()
    console.log("Loading took:", (et - dt2), "ms")

    const m2 = process.memoryUsage()
    const usedDelta = m1.heapUsed && Math.abs(m1.heapUsed - m2.heapUsed) / m1.heapUsed * 100
    const totalDelta = m1.heapTotal && Math.abs(m1.heapTotal - m2.heapTotal) / m1.heapTotal * 100

    let usedOutput = `Memory Heap Used: ${(m2.heapUsed / 1024 / 1024).toFixed(2)} MB`
    usedOutput += ` (${m2.heapUsed > m1.heapUsed ? '+' : '-'}${usedDelta.toFixed(2)}%)`
    let totalOutput = `Memory Heap Total: ${(m2.heapTotal / 1024 / 1024).toFixed(2)} MB`
    totalOutput += ` (${m2.heapTotal > m1.heapTotal ? '+' : '-'}${totalDelta.toFixed(2)}%)`

    console.log(usedOutput)
    console.log(totalOutput)

    process.exit(0)
  })
})()

module.exports = run
