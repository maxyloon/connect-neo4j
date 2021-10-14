module.exports = function (session) {
    const Store = session.Store

    const noop = () => {}
  
    class Neo4jStore extends Store {
      constructor(options = {}) {
        super(options)
        if (!options.client) {
          throw new Error('A session must be directly provided to the Neo4jStore')
        }
  
        this.prefix = options.prefix == null ? 'sess:' : options.prefix
        this.scanCount = Number(options.scanCount) || 100
        this.serializer = options.serializer || JSON
        this.client = options.client
        this.nodeLabel = options.nodeLabel || 'Session'
        this.ttl = options.ttl || 86400 // One day in seconds.
        this.disableTTL = options.disableTTL || false
        this.disableTouch = options.disableTouch || false
      }
      get(sid, cb = noop) {
        let key = this.prefix + sid
  
        this.client.run(`MATCH (s:${this.nodeLabel} {sid: {sid}}) RETURN s`, { key })
          .then(result => {
            if (result.records.length === 0) {
              return cb(null, null)
            }
  
            let record = result.records[0]
            let session = record.get('s')
  
            let data = session.properties.data
            let expires = session.properties.expires
  
            if (this.disableTTL) {
              expires = null
            }
  
            if (this.disableTouch) {
              expires = null
            }
  
            if (expires && expires < Date.now()) {
              this.destroy(sid, noop)
              return cb(null, null)
            }
  
            cb(null, this.serializer.deserialize(data))
          })
          .catch(cb)
      }

    }
    return Neo4jStore
}