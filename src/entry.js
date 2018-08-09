'use strict'

const Clock = require('./lamport-clock')
const isDefined = require('./utils/is-defined')

const IpfsNotDefinedError = () => new Error('Ipfs instance not defined')
const encode = data => Buffer.from(JSON.stringify(data))

class Entry {
  /**
   * Create an Entry
   * @param {string|Buffer|Object|Array} data - Data of the entry to be added. Can be any JSON.stringifyable data.
   * @param {Array<Entry|string>} [next=[]] Parents of the entry
   * @example
   * const entry = await Entry.createAndPublish(ipfs, 'hello')
   * console.log(entry)
   * // { hash: null, payload: "hello", next: [] }
   * @returns {Promise<Entry>}
   */
  static async createAndPublish (id, data, next = [], clock, nodeId, identity, ipfs) {
    if (!isDefined(ipfs)) throw IpfsNotDefinedError()
    if (!isDefined(identity)) throw new Error("Identity is required, cannot create entry")
    if (!isDefined(id)) throw new Error('Entry requires an id')
    if (!isDefined(data)) throw new Error('Entry requires data')
    if (!isDefined(next) || !Array.isArray(next)) throw new Error("'next' argument is not an array")

    // Clean the next objects and convert to hashes
    const toEntry = (e) => e.hash ? e.hash : e
    let nexts = next.filter(isDefined)
      .map(toEntry)

    // Take the id of the given clock by default,
    // if clock not given, take the signing key if it's a Key instance,
    // or if none given, take the id as the clock id
    const clockId = clock ? clock.id : (nodeId ? nodeId : id)
    const clockTime = clock ? clock.time : null
    const entry = {
      hash: null, // "Qm...Foo", we'll set the hash after persisting the entry
      id: id, // For determining a unique chain
      payload: data, // Can be any JSON.stringifyable data
      next: nexts, // Array of Multihashes
      v: 0, // For future data structure updates, should currently always be 0
      clock: new Clock(clockId, clockTime),
    }

    const signature = await identity.provider.sign(encode(entry))
    entry.key = identity.publicKey
    entry.sig = signature
    entry.hash = await Entry.toMultihash(ipfs, entry)
    return entry
  }

  /**
   * Verifies an entry signature for a given key and sig
   * @param  {Entry}  entry Entry to verify
   * @return {Promise}      Returns a promise that resolves to a boolean value
   * indicating if the entry signature is valid
   */
  static async verify (identity, entry) {
    if (!identity) throw new Error("Identity is required, cannot verify entry")
    if (!Entry.isEntry(entry)) throw new Error("Invalid Log entry")
    if (!entry.key) throw new Error("Entry doesn't have a public key")
    if (!entry.sig) throw new Error("Entry doesn't have a signature")

    const e = Object.assign({}, {
      hash: null,
      id: entry.id,
      payload: entry.payload,
      next: entry.next,
      v: entry.v,
      clock: entry.clock,
    })

    return identity.provider.verify(entry.sig, entry.key, encode(e))
  }

  /**
   * Get the multihash of an Entry
   * @param {IPFS} [ipfs] An IPFS instance
   * @param {Entry} [entry] Entry to get a multihash for
   * @example
   * const hash = await Entry.toMultihash(ipfs, entry)
   * console.log(hash)
   * // "Qm...Foo"
   * @returns {Promise<string>}
   */
  static toMultihash (ipfs, entry) {
    if (!ipfs) throw IpfsNotDefinedError()
    const isValidEntryObject = entry => entry.id && entry.clock && entry.next && entry.payload && entry.v >= 0
    if (!isValidEntryObject(entry)) {
      throw new Error('Invalid object format, cannot generate entry multihash')
    }

    // Ensure `entry` follows the correct format
    const e = {
      hash: null,
      id: entry.id,
      payload: entry.payload,
      next: entry.next,
      v: entry.v,
      clock: entry.clock,
    }

    if (entry.sig) Object.assign(e, { sig: entry.sig })
    if (entry.key) Object.assign(e, { key: entry.key })

    const data = Buffer.from(JSON.stringify(e))
    return ipfs.object.put(data)
      .then((res) => res.toJSON().multihash)
  }

  /**
   * Create an Entry from a multihash
   * @param {IPFS} [ipfs] An IPFS instance
   * @param {string} [hash] Multihash as Base58 encoded string to create an Entry from
   * @example
   * const hash = await Entry.fromMultihash(ipfs, "Qm...Foo")
   * console.log(hash)
   * // { hash: "Qm...Foo", payload: "hello", next: [] }
   * @returns {Promise<Entry>}
   */
  static fromMultihash (ipfs, hash) {
    if (!ipfs) throw IpfsNotDefinedError()
    if (!hash) throw new Error(`Invalid hash: ${hash}`)
    return ipfs.object.get(hash, { enc: 'base58' })
      .then((obj) => JSON.parse(obj.toJSON().data))
      .then((data) => {
        let entry = {
          hash: hash,
          id: data.id,
          payload: data.payload,
          next: data.next,
          v: data.v,
          clock: data.clock,
        }
        if (data.sig) Object.assign(entry, { sig: data.sig })
        if (data.key) Object.assign(entry, { key: data.key })
        return entry
      })
  }

  /**
   * Check if an object is an Entry
   * @param {Entry} obj
   * @returns {boolean}
   */
  static isEntry (obj) {
    return obj && obj.id !== undefined
      && obj.next !== undefined
      && obj.hash !== undefined
      && obj.payload !== undefined
      && obj.v !== undefined
      && obj.clock !== undefined
  }

  static compare (a, b) {
    var distance = Clock.compare(a.clock, b.clock)
    if (distance === 0) return a.clock.id < b.clock.id ? -1 : 1
    return distance
  }

  /**
   * Check if an entry equals another entry
   * @param {Entry} a
   * @param {Entry} b
   * @returns {boolean}
   */
  static isEqual (a, b) {
    return a.hash === b.hash
  }

  /**
   * Check if an entry is a parent to another entry.
   * @param {Entry} [entry1] Entry to check
   * @param {Entry} [entry2] Parent
   * @returns {boolean}
   */
  static isParent (entry1, entry2) {
    return entry2.next.indexOf(entry1.hash) > -1
  }

  /**
   * Find entry's children from an Array of entries
   *
   * @description
   * Returns entry's children as an Array up to the last know child.
   *
   * @param {Entry} [entry] Entry for which to find the parents
   * @param {Array<Entry>} [vaules] Entries to search parents from
   * @returns {Array<Entry>}
   */
  static findChildren (entry, values) {
    var stack = []
    var parent = values.find((e) => Entry.isParent(entry, e))
    var prev = entry
    while (parent) {
      stack.push(parent)
      prev = parent
      parent = values.find((e) => Entry.isParent(prev, e))
    }
    stack = stack.sort((a, b) => a.clock.time > a.clock.time)
    return stack
  }
}

module.exports = Entry
