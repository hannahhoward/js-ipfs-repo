'use strict'

const { shard, ShardingDatastore } = require('datastore-core')
const Block = require('ipld-block')
const { cidToKey, keyToCid } = require('./blockstore-utils')
const map = require('it-map')
const drain = require('it-drain')
const pushable = require('it-pushable')
/**
 * @typedef {import("interface-datastore").Query} Query
 * @typedef {import("interface-datastore").Datastore} Datastore
 * @typedef {import("interface-datastore").Options} DatastoreOptions
 * @typedef {import("cids")} CID
 */

/**
 *
 * @param {Datastore} filestore
 * @param {*} options
 */
module.exports = (filestore, options) => {
  const store = maybeWithSharding(filestore, options)
  return createBaseStore(store)
}

/**
 * @param {Datastore} filestore
 * @param {{ sharding: any; }} options
 */
function maybeWithSharding (filestore, options) {
  if (options.sharding) {
    return new ShardingDatastore(filestore, new shard.NextToLast(2))
  }
  return filestore
}

/**
 * @param {Datastore | ShardingDatastore} store
 */
function createBaseStore (store) {
  return {
    open () {
      return store.open()
    },
    /**
     * Query the store
     *
     * @param {Query} query
     * @param {DatastoreOptions} [options]
     * @returns {AsyncIterable<Block|CID>}
     */
    async * query (query, options) {
      for await (const { key, value } of store.query(query, options)) {
        // TODO: we should make this a different method
        if (query.keysOnly) {
          yield keyToCid(key)
          continue
        }

        yield new Block(value, keyToCid(key))
      }
    },

    /**
     * Get a single block by CID
     *
     * @param {CID} cid
     * @param {DatastoreOptions} [options]
     * @returns {Promise<Block>}
     */
    async get (cid, options) {
      const key = cidToKey(cid)
      const blockData = await store.get(key, options)

      return new Block(blockData, cid)
    },

    /**
     * Like get, but for more
     *
     * @param {Iterable<CID> | AsyncIterable<CID>} cids
     * @param {DatastoreOptions} [options]
     * @returns {AsyncIterable<Block>}
     */
    async * getMany (cids, options) {
      for await (const cid of cids) {
        yield this.get(cid, options)
      }
    },

    /**
     * Write a single block to the store
     *
     * @param {Block} block
     * @param {DatastoreOptions} [options]
     * @returns {Promise<Block>}
     */
    async put (block, options) {
      if (!Block.isBlock(block)) {
        throw new Error('invalid block')
      }

      const key = cidToKey(block.cid)
      const exists = await store.has(key, options)

      if (!exists) {
        await store.put(key, block.data, options)
      }

      return block
    },

    /**
     * Like put, but for more
     *
     * @param {AsyncIterable<Block>|Iterable<Block>} blocks
     * @param {DatastoreOptions} [options]
     * @returns {AsyncIterable<Block>}
     */
    async * putMany (blocks, options) { // eslint-disable-line require-await
      // we cannot simply chain to `store.putMany` because we convert a CID into
      // a key based on the multihash only, so we lose the version & codec and
      // cannot give the user back the CID they used to create the block, so yield
      // to `store.putMany` but return the actual block the user passed in.
      //
      // nb. we want to use `store.putMany` here so bitswap can control batching
      // up block HAVEs to send to the network - if we use multiple `store.put`s
      // it will not be able to guess we are about to `store.put` more blocks
      const output = pushable()

      // process.nextTick runs on the microtask queue, setImmediate runs on the next
      // event loop iteration so is slower. Use process.nextTick if it is available.
      const runner = process && process.nextTick ? process.nextTick : setImmediate

      runner(async () => {
        try {
          await drain(store.putMany(async function * () {
            for await (const block of blocks) {
              const key = cidToKey(block.cid)
              const exists = await store.has(key, options)

              if (!exists) {
                yield { key, value: block.data }
              }

              // there is an assumption here that after the yield has completed
              // the underlying datastore has finished writing the block
              output.push(block)
            }
          }()))

          output.end()
        } catch (err) {
          output.end(err)
        }
      })

      yield * output
    },

    /**
     * Does the store contain block with this CID?
     *
     * @param {CID} cid
     * @param {DatastoreOptions} [options]
     */
    has (cid, options) {
      return store.has(cidToKey(cid), options)
    },

    /**
     * Delete a block from the store
     *
     * @param {CID} cid
     * @param {DatastoreOptions} [options]
     * @returns {Promise<void>}
     */
    delete (cid, options) {
      return store.delete(cidToKey(cid), options)
    },

    /**
     * Delete a block from the store
     *
     * @param {AsyncIterable<any> | Iterable<any>} cids
     * @param {DatastoreOptions} [options]
     */
    deleteMany (cids, options) {
      return store.deleteMany(map(cids, cid => cidToKey(cid)), options)
    },

    /**
     * Close the store
     *
     */
    close () {
      return store.close()
    }
  }
}
