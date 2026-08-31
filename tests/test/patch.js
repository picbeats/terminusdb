const { expect } = require('chai')
const { Agent, api, document, db, util } = require('../lib')

function rawParse (res, cb) {
  let data = ''
  res.on('data', chunk => { data += chunk })
  res.on('end', () => {
    const jsonStart = data.indexOf('{')
    if (jsonStart > 0) data = data.substring(jsonStart)
    try { cb(null, JSON.parse(data)) } catch (e) { cb(null, data) }
  })
}

function dataVersionHeader (res) {
  return res.header['terminusdb-data-version']
}

describe('patch', function () {
  let agent
  let ty1
  let ids
  let id1
  let id2

  before(function () {
    agent = new Agent().auth()
  })

  describe('1 database, shared', function () {
    beforeEach(async function () {
      await db.create(agent)
      ty1 = util.randomString()
      const schema = [
        {
          '@type': 'Class',
          '@id': ty1,
          name: 'xsd:string',
          other: { '@type': 'Optional', '@class': 'xsd:string' },
          friend: { '@type': 'Optional', '@class': ty1 },
          refs: { '@type': 'List', '@class': ty1 },
        },
      ]
      const instance = [
        {
          '@type': ty1,
          name: 'foo',
          refs: [],
        },
        {
          '@type': ty1,
          name: 'bar',
          refs: [],
        },
      ]
      await document.insert(agent, { schema })
      const response = await document.insert(agent, { instance })
      ids = response.body
      id1 = ids[0]
      id2 = ids[1]
    })

    afterEach(async function () {
      await db.delete(agent)
    })

    it('applies patch to db', async function () {
      const path = api.path.patchDb(agent)
      const patch = { '@id': id1, name: { '@op': 'SwapValue', '@before': 'foo', '@after': 'bar' } }
      const author = 'me'
      const message = 'yo'
      const res = await agent.post(path).send({ patch, author, message })
      expect(res.body).to.deep.equal([id1])
    })

    it('returns and enforces TerminusDB-Data-Version', async function () {
      const path = api.path.patchDb(agent)
      const before = await document.get(agent, { query: { id: id1, as_list: true } })
      const v0 = dataVersionHeader(before)
      const applied = await agent.post(path)
        .set('TerminusDB-Data-Version', v0)
        .send({
          patch: { '@id': id1, name: { '@op': 'SwapValue', '@before': 'foo', '@after': 'bar' } },
          author: 'me',
          message: 'versioned patch',
        })
      const v1 = dataVersionHeader(applied)

      expect(applied.status).to.equal(200)
      expect(v1).to.match(/^branch:/)
      expect(v1).to.not.equal(v0)

      const stale = await agent.post(path)
        .set('TerminusDB-Data-Version', v0)
        .send({
          patch: { '@id': id1, name: { '@op': 'SwapValue', '@before': 'bar', '@after': 'baz' } },
          author: 'me',
          message: 'stale versioned patch',
        })

      expect(stale.status).to.equal(400)
      expect(stale.body['api:error']).to.deep.equal(api.error.dataVersionMismatch(v0, v1))
      const current = await document.get(agent, { query: { id: id1, as_list: true } })
      expect(current.body[0].name).to.equal('bar')
    })

    it('applies mixed inserts, an existing-root update, and a delete atomically', async function () {
      const path = api.path.patchDb(agent)
      const mary = `${ty1}/Mary`
      const patch = [
        {
          '@op': 'Insert',
          '@insert': { '@id': mary, '@capture': 'mary', '@type': ty1, name: 'Mary', refs: [] },
        },
        {
          '@id': id1,
          friend: { '@op': 'SwapValue', '@before': null, '@after': { '@ref': 'mary' } },
        },
        { '@op': 'Delete', '@delete': { '@id': id2 } },
      ]
      const res = await agent.post(path).send({ patch, author: 'me', message: 'mixed patch' })

      expect(res.status).to.equal(200)
      expect(res.body).to.have.lengthOf(3)
      expect(res.body[1]).to.equal(id1)
      expect(res.body[2]).to.equal(id2)
      const john = await document.get(agent, { query: { id: id1, as_list: true } })
      expect(john.body[0].friend).to.equal(mary)
      const inserted = await document.get(agent, { query: { id: res.body[0], as_list: true } })
      expect(inserted.body[0].name).to.equal('Mary')
      const deleted = await agent.get(api.path.document(agent)).query({ id: id2 }).buffer(true).parse(rawParse)
      expect(deleted.body['api:status']).to.equal('api:not_found')
    }).timeout(10000)

    it('rolls back a mixed patch when an existing-root update conflicts', async function () {
      const path = api.path.patchDb(agent)
      const inserted = `${ty1}/Rollback`
      const patch = [
        { '@op': 'Insert', '@insert': { '@id': inserted, '@type': ty1, name: 'Rollback', refs: [] } },
        { '@id': id1, name: { '@op': 'SwapValue', '@before': 'wrong', '@after': 'changed' } },
        { '@op': 'Delete', '@delete': { '@id': id2 } },
      ]
      const res = await agent.post(path).send({ patch, author: 'me', message: 'rollback', match_final_state: false })

      expect(res.status).to.equal(409)
      const absent = await agent.get(api.path.document(agent)).query({ id: inserted }).buffer(true).parse(rawParse)
      expect(absent.body['api:status']).to.equal('api:not_found')
      const unchanged = await document.get(agent, { query: { id: id1, as_list: true } })
      expect(unchanged.body[0].name).to.equal('foo')
      const retained = await document.get(agent, { query: { id: id2, as_list: true } })
      expect(retained.body[0].name).to.equal('bar')
    }).timeout(10000)

    it('allows non-overlapping field patches and rejects an incompatible same-field patch', async function () {
      const path = api.path.patchDb(agent)
      const first = await agent.post(path).send({
        patch: { '@id': id1, name: { '@op': 'SwapValue', '@before': 'foo', '@after': 'first' } },
        author: 'me',
        message: 'first field change',
      })
      const other = await agent.post(path).send({
        patch: { '@id': id1, other: { '@op': 'SwapValue', '@before': null, '@after': 'other' } },
        author: 'me',
        message: 'other field change',
      })
      const conflicting = await agent.post(path).send({
        patch: { '@id': id1, name: { '@op': 'SwapValue', '@before': 'foo', '@after': 'second' } },
        author: 'me',
        message: 'conflicting field change',
        match_final_state: false,
      })

      expect(first.status).to.equal(200)
      expect(other.status).to.equal(200)
      expect(conflicting.status).to.equal(409)
      const current = await document.get(agent, { query: { id: id1, as_list: true } })
      expect(current.body[0]).to.include({ name: 'first', other: 'other' })
    })

    it('rejects writes from a read-only principal', async function () {
      const user = util.randomString()
      await agent.post('/api/users').send({ name: user, password: user })
      await agent.post('/api/capabilities').send({
        operation: 'grant',
        scope: `${agent.orgName}/${agent.dbName}`,
        user,
        roles: ['Consumer Role'],
        scope_type: 'database',
      })
      const readOnly = new Agent({ orgName: agent.orgName, dbName: agent.dbName })
        .auth({ user, password: user, skipJwt: true })
      const readable = await document.get(readOnly, { query: { id: id1, as_list: true } })
      const rejected = await readOnly.post(api.path.patchDb(readOnly)).send({
        patch: { '@id': id1, name: { '@op': 'SwapValue', '@before': 'foo', '@after': 'bar' } },
        author: user,
        message: 'forbidden patch',
      })

      expect(readable.status).to.equal(200)
      expect(rejected.status).to.equal(403)
      const unchanged = await document.get(agent, { query: { id: id1, as_list: true } })
      expect(unchanged.body[0].name).to.equal('foo')
    }).timeout(10000)

    it('replays an identical captured insert before a later captured field patch', async function () {
      const path = api.path.patchDb(agent)
      const mary = `${ty1}/Mary`
      const patch = [
        {
          '@op': 'Insert',
          '@insert': { '@id': mary, '@capture': 'mary', '@type': ty1, name: 'Mary', refs: [] },
        },
        {
          '@id': id1,
          friend: { '@op': 'SwapValue', '@before': null, '@after': { '@ref': 'mary' } },
        },
      ]
      const first = await agent.post(path).send({ patch, author: 'me', message: 'first captured patch' })
      const second = await agent.post(path).send({ patch, author: 'me', message: 'replayed captured patch' })

      expect(first.status).to.equal(200)
      expect(second.status).to.equal(200)
      const current = await document.get(agent, { query: { id: id1, as_list: true } })
      expect(current.body[0].friend).to.equal(mary)
    }).timeout(10000)

    it('resolves captured references inside list patch values', async function () {
      const path = api.path.patchDb(agent)
      const mary = `${ty1}/Mary`
      const res = await agent.post(path).send({
        patch: [
          {
            '@op': 'Insert',
            '@insert': { '@id': mary, '@capture': 'mary', '@type': ty1, name: 'Mary', refs: [] },
          },
          {
            '@id': id1,
            refs: { '@op': 'SwapValue', '@before': [], '@after': [{ '@ref': 'mary' }] },
          },
        ],
        author: 'me',
        message: 'captured list patch',
      })

      expect(res.status).to.equal(200)
      const current = await document.get(agent, { query: { id: id1, as_list: true } })
      expect(current.body[0].refs).to.deep.equal([mary])
    }).timeout(10000)

    it('rejects a field patch that references an unknown capture', async function () {
      const res = await agent.post(api.path.patchDb(agent)).send({
        patch: {
          '@id': id1,
          friend: { '@op': 'SwapValue', '@before': null, '@after': { '@ref': 'missing' } },
        },
        author: 'me',
        message: 'missing capture',
      })

      expect(res.status).to.equal(400)
      expect(res.body['api:error']['@type']).to.equal('api:NotAllCapturesFound')
    })

    it('applies patch to db and gets a conflict', async function () {
      const path = api.path.patchDb(agent)
      const patch = { '@id': id1, name: { '@op': 'SwapValue', '@before': 'quux', '@after': 'zippo' } }
      const author = 'me'
      const message = 'yo'
      const res = await agent.post(path).send({ patch, author, message })

      // Verify request_id exists and is valid UUID format (any version)
      expect(res.body).to.have.property('api:request_id')
      expect(res.body['api:request_id']).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

      // Remove request_id for comparison of the rest of the structure
      const { 'api:request_id': _, ...bodyWithoutRequestId } = res.body

      expect(bodyWithoutRequestId).to.deep.equal({
        '@type': 'api:PatchResponse',
        'api:error': {
          '@type': 'api:PatchConflict',
          'api:conflicts': [
            {
              '@id': id1,
              name: {
                '@expected': 'quux',
                '@found': 'foo',
                '@op': 'Conflict',
              },
            },
          ],
        },
        'api:message': 'The patch did not apply cleanly because of the attached conflicts',
        'api:status': 'api:conflict',
      })
    })

    it('applies several patches to db with final state match', async function () {
      const path = api.path.patchDb(agent)
      const patch = [{ '@id': id1, name: { '@op': 'SwapValue', '@before': 'foo', '@after': 'bar' } },
        { '@id': id2, name: { '@op': 'SwapValue', '@before': 'foo', '@after': 'bar' } }]
      const author = 'me'
      const message = 'yo'
      const res = await agent.post(path).send({ patch, author, message })
      expect(res.body).to.deep.equal([id1, id2])
    })

    it('fails apply several patches to db without final state match', async function () {
      const path = api.path.patchDb(agent)
      const patch = [{ '@id': id1, name: { '@op': 'SwapValue', '@before': 'foo', '@after': 'bar' } },
        { '@id': id2, name: { '@op': 'SwapValue', '@before': 'foo', '@after': 'bar' } }]
      const author = 'me'
      const message = 'yo'
      const res = await agent.post(path).send({
        match_final_state: false,
        patch,
        author,
        message,
      })

      // Verify request_id exists and is valid UUID format (any version)
      expect(res.body).to.have.property('api:request_id')
      expect(res.body['api:request_id']).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

      // Remove request_id for comparison of the rest of the structure
      const { 'api:request_id': _, ...bodyWithoutRequestId } = res.body

      expect(bodyWithoutRequestId).to.deep.equal({
        '@type': 'api:PatchResponse',
        'api:error':
        {
          '@type': 'api:PatchConflict',
          'api:conflicts': [
            {
              '@id': id2,
              name: { '@expected': 'foo', '@found': 'bar', '@op': 'Conflict' },
            },
          ],
        },
        'api:message': 'The patch did not apply cleanly because of the attached conflicts',
        'api:status': 'api:conflict',
      })
    })

    it('applies patch to enum value without false conflict', async function () {
      // Schema with enum type
      const enumSchema = [
        {
          '@id': 'LocalStatusType',
          '@type': 'Enum',
          '@value': ['UP_TO_DATE', 'NEVER_RAN'],
        },
        {
          '@id': 'B',
          '@key': { '@type': 'Random' },
          '@type': 'Class',
          local_status_type: 'LocalStatusType',
        },
      ]
      await document.insert(agent, { schema: enumSchema })

      // Insert instance with enum value
      const instance = [
        {
          '@type': 'B',
          local_status_type: 'UP_TO_DATE',
        },
      ]
      const response = await document.insert(agent, { instance })
      const enumId = response.body[0]

      // Apply patch to change enum value
      const path = api.path.patchDb(agent)
      const patch = {
        '@id': enumId,
        local_status_type: {
          '@op': 'SwapValue',
          '@before': 'UP_TO_DATE',
          '@after': 'NEVER_RAN',
        },
      }
      const author = 'test'
      const message = 'change enum value'
      const res = await agent.post(path).send({ patch, author, message })

      // Should succeed without conflict
      expect(res.body).to.deep.equal([enumId])
    })

    it('applies patch to decimal property without false conflict', async function () {
      // Schema with decimal type
      const decimalSchema = [
        {
          '@id': 'DecimalTest',
          '@type': 'Class',
          '@key': { '@type': 'Random' },
          weight: 'xsd:decimal',
        },
      ]
      await document.insert(agent, { schema: decimalSchema })

      // Insert instance with a decimal value
      const instance = [
        {
          '@type': 'DecimalTest',
          weight: 1.1,
        },
      ]
      const response = await document.insert(agent, { instance })
      const decimalId = response.body[0]

      // Apply patch to change decimal value using JSON numbers, reproducing the
      // reported issue where a float-rounded @before did not match the stored rational.
      const path = api.path.patchDb(agent)
      const patch = {
        '@id': decimalId,
        weight: {
          '@op': 'SwapValue',
          '@before': 1.1,
          '@after': 1.2,
        },
      }
      const author = 'test'
      const message = 'change decimal weight'
      const res = await agent.post(path).send({ patch, author, message })

      // Should succeed without conflict
      if (res.status !== 200) {
        console.log('DECIMAL PATCH FAILED - status:', res.status)
        console.log('DECIMAL PATCH FAILED - body:', res.text)
      }
      expect(res.status).to.equal(200)
      expect(res.body).to.deep.equal([decimalId])
    })

    it('applies insert and delete via patch', async function () {
      const insertPatch = [
        { '@op': 'Delete', '@delete': { '@id': id1 } },
        { '@op': 'Insert', '@insert': { '@id': `${ty1}/Inserted`, '@type': ty1, name: 'inserted' } },
      ]
      const path = api.path.patchDb(agent)
      const author = 'me'
      const message = 'insert and delete via patch'
      const res = await agent.post(path).send({ patch: insertPatch, author, message })
      expect(res.status).to.equal(200)

      const getRes1 = await agent.get(api.path.document(agent)).query({ id: id1 }).buffer(true).parse(rawParse)
      expect(getRes1.body['api:status']).to.equal('api:not_found')

      const getRes2 = await agent.get(api.path.document(agent)).query({ id: `${ty1}/Inserted` })
      expect(getRes2.status).to.equal(200)
      expect(getRes2.body.name).to.equal('inserted')
    }).timeout(10000)

    it('applies delete via string id in patch', async function () {
      const patch = [{ '@op': 'Delete', '@delete': id1 }]
      const path = api.path.patchDb(agent)
      const author = 'me'
      const message = 'delete via string id'
      const res = await agent.post(path).send({ patch, author, message })
      expect(res.status).to.equal(200)

      const getRes = await agent.get(api.path.document(agent)).query({ id: id1 }).buffer(true).parse(rawParse)
      expect(getRes.body['api:status']).to.equal('api:not_found')
    }).timeout(10000)

    it('patch with mixed insert and conflict rolls back entire transaction', async function () {
      const patch = [
        { '@op': 'Insert', '@insert': { '@id': `${ty1}/RollbackTest`, '@type': ty1, name: 'rollback' } },
        { '@op': 'Delete', '@delete': { '@id': 'Nonexistent/Document' } },
      ]
      const path = api.path.patchDb(agent)
      const author = 'me'
      const message = 'mixed conflict rollback'
      const res = await agent.post(path).send({ patch, author, message, match_final_state: false })
      expect(res.status).to.equal(409)
      expect(res.body['api:status']).to.equal('api:conflict')

      const getRes = await agent.get(api.path.document(agent)).query({ id: `${ty1}/RollbackTest` }).buffer(true).parse(rawParse)
      expect(getRes.body['api:status']).to.equal('api:not_found')
    }).timeout(10000)

    it('insert with captures creates cross-references between documents', async function () {
      const refClass = util.randomString()
      const schema = [
        {
          '@type': 'Class',
          '@id': refClass,
          name: 'xsd:string',
          friend: refClass,
        },
      ]
      await document.insert(agent, { schema })
      const path = api.path.patchDb(agent)
      const patch = [
        {
          '@op': 'Insert',
          '@insert': {
            '@type': refClass,
            '@capture': 'PersonA',
            name: 'Alice',
            friend: { '@ref': 'PersonB' },
          },
        },
        {
          '@op': 'Insert',
          '@insert': {
            '@type': refClass,
            '@capture': 'PersonB',
            name: 'Bob',
            friend: { '@ref': 'PersonA' },
          },
        },
      ]
      const res = await agent.post(path).send({ patch, author: 'me', message: 'captures insert' })
      expect(res.status).to.equal(200)

      const insertedIds = res.body
      expect(insertedIds).to.have.lengthOf(2)

      const docA = await document.get(agent, { query: { id: insertedIds[0], as_list: true } })
      const docB = await document.get(agent, { query: { id: insertedIds[1], as_list: true } })
      const aName = docA.body[0].name

      const aliceDoc = aName === 'Alice' ? docA.body[0] : docB.body[0]
      const bobDoc = aName === 'Bob' ? docA.body[0] : docB.body[0]

      expect(aliceDoc.friend).to.equal(bobDoc['@id'])
      expect(bobDoc.friend).to.equal(aliceDoc['@id'])
    }).timeout(10000)

    it('insert with unmatched capture ref fails', async function () {
      const refClass = util.randomString()
      const schema = [
        {
          '@type': 'Class',
          '@id': refClass,
          name: 'xsd:string',
          friend: refClass,
        },
      ]
      await document.insert(agent, { schema })
      const path = api.path.patchDb(agent)
      const patch = [
        {
          '@op': 'Insert',
          '@insert': {
            '@type': refClass,
            '@capture': 'PersonA',
            name: 'Alice',
            friend: { '@ref': 'Nonexistent' },
          },
        },
      ]
      const res = await agent.post(path).send({ patch, author: 'me', message: 'unmatched capture' })
      expect(res.status).to.equal(400)
    }).timeout(10000)

    it('insert with @id and @capture uses @id for document and @capture for refs', async function () {
      const refClass = util.randomString()
      const schema = [
        {
          '@type': 'Class',
          '@id': refClass,
          name: 'xsd:string',
          friend: refClass,
        },
      ]
      await document.insert(agent, { schema })
      const path = api.path.patchDb(agent)
      const patch = [
        {
          '@op': 'Insert',
          '@insert': {
            '@id': `${refClass}/Alice`,
            '@type': refClass,
            '@capture': 'PersonA',
            name: 'Alice',
            friend: { '@ref': 'PersonB' },
          },
        },
        {
          '@op': 'Insert',
          '@insert': {
            '@id': `${refClass}/Bob`,
            '@type': refClass,
            '@capture': 'PersonB',
            name: 'Bob',
            friend: { '@ref': 'PersonA' },
          },
        },
      ]
      const res = await agent.post(path).send({ patch, author: 'me', message: 'id and capture' })
      expect(res.status).to.equal(200)

      const aliceDoc = await document.get(agent, { query: { id: `${refClass}/Alice`, as_list: true } })
      const bobDoc = await document.get(agent, { query: { id: `${refClass}/Bob`, as_list: true } })
      expect(aliceDoc.body[0].name).to.equal('Alice')
      expect(aliceDoc.body[0].friend).to.equal(`${refClass}/Bob`)
      expect(bobDoc.body[0].name).to.equal('Bob')
      expect(bobDoc.body[0].friend).to.equal(`${refClass}/Alice`)
    }).timeout(10000)

    it('field-level patch with SwapValue after captures insert', async function () {
      const refClass = util.randomString()
      const schema = [
        {
          '@type': 'Class',
          '@id': refClass,
          name: 'xsd:string',
          friend: refClass,
        },
      ]
      await document.insert(agent, { schema })
      const path = api.path.patchDb(agent)

      const setupPatch = [
        {
          '@op': 'Insert',
          '@insert': {
            '@id': `${refClass}/Alice`,
            '@type': refClass,
            '@capture': 'PersonA',
            name: 'Alice',
            friend: { '@ref': 'PersonB' },
          },
        },
        {
          '@op': 'Insert',
          '@insert': {
            '@id': `${refClass}/Bob`,
            '@type': refClass,
            '@capture': 'PersonB',
            name: 'Bob',
            friend: { '@ref': 'PersonA' },
          },
        },
        {
          '@op': 'Insert',
          '@insert': {
            '@id': `${refClass}/Charlie`,
            '@type': refClass,
            name: 'Charlie',
            friend: { '@ref': 'PersonA' },
          },
        },
      ]
      const setupRes = await agent.post(path).send({ patch: setupPatch, author: 'me', message: 'setup with captures' })
      expect(setupRes.status).to.equal(200)

      const fieldPatch = [
        {
          '@id': `${refClass}/Charlie`,
          name: { '@op': 'SwapValue', '@before': 'Charlie', '@after': 'Charles' },
        },
      ]
      const fieldRes = await agent.post(path).send({ patch: fieldPatch, author: 'me', message: 'field patch' })
      expect(fieldRes.status).to.equal(200)

      const charlieDoc = await document.get(agent, { query: { id: `${refClass}/Charlie`, as_list: true } })
      expect(charlieDoc.body[0].name).to.equal('Charles')
    }).timeout(10000)

    it('field-level SwapValue with @ref on document reference field', async function () {
      const refClass = util.randomString()
      const schema = [
        {
          '@type': 'Class',
          '@id': refClass,
          name: 'xsd:string',
          friend: { '@type': 'Optional', '@class': refClass },
        },
      ]
      await document.insert(agent, { schema })
      const path = api.path.patchDb(agent)

      const setupPatch = [
        {
          '@op': 'Insert',
          '@insert': {
            '@id': `${refClass}/Charlie`,
            '@type': refClass,
            name: 'Charlie',
          },
        },
      ]
      const setupRes = await agent.post(path).send({ patch: setupPatch, author: 'me', message: 'insert Charlie' })
      expect(setupRes.status).to.equal(200)

      const patch = [
        {
          '@op': 'Insert',
          '@insert': {
            '@id': `${refClass}/Alice`,
            '@type': refClass,
            '@capture': 'PersonA',
            name: 'Alice',
            friend: { '@ref': 'PersonB' },
          },
        },
        {
          '@op': 'Insert',
          '@insert': {
            '@id': `${refClass}/Bob`,
            '@type': refClass,
            '@capture': 'PersonB',
            name: 'Bob',
            friend: { '@ref': 'PersonA' },
          },
        },
        {
          '@id': `${refClass}/Charlie`,
          friend: { '@op': 'SwapValue', '@before': null, '@after': { '@ref': 'PersonA' } },
        },
      ]
      const res = await agent.post(path).send({ patch, author: 'me', message: 'swap Charlie friend with ref' })
      expect(res.status).to.equal(200)

      const charlieDoc = await document.get(agent, { query: { id: `${refClass}/Charlie`, as_list: true } })
      expect(charlieDoc.body[0].friend).to.equal(`${refClass}/Alice`)
    }).timeout(10000)
  })
})
