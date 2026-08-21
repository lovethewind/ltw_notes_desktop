const assert = require('node:assert/strict')
const test = require('node:test')
const { classifyAttachmentSource } = require('../electron/attachment-source.cjs')

const settings = {
  backendUrl: 'https://lovethewind.cn',
  webUrl: 'https://www.lovethewind.cn'
}

test('本地、本站及服务端签发资源归为笔记附件', () => {
  assert.deepEqual(
    classifyAttachmentSource({ remoteUrl: null, serverSourceId: null }, settings),
    { sourceKind: 'managed', sourceHost: '' }
  )
  assert.deepEqual(
    classifyAttachmentSource({ remoteUrl: 'https://lovethewind.cn/files/a.png', serverSourceId: null }, settings),
    { sourceKind: 'managed', sourceHost: 'lovethewind.cn' }
  )
  assert.deepEqual(
    classifyAttachmentSource({ remoteUrl: 'https://cdn.lovethewind.cn/files/a.png', serverSourceId: null }, settings),
    { sourceKind: 'managed', sourceHost: 'cdn.lovethewind.cn' }
  )
  assert.deepEqual(
    classifyAttachmentSource({ remoteUrl: 'https://oss.example.net/files/a.png', serverSourceId: 'source-1' }, settings),
    { sourceKind: 'managed', sourceHost: 'oss.example.net' }
  )
})

test('其他站点资源归为外链缓存且不会误认相似域名', () => {
  assert.deepEqual(
    classifyAttachmentSource({ remoteUrl: 'https://images.example.net/archive/a.png', serverSourceId: null }, settings),
    { sourceKind: 'external-cache', sourceHost: 'images.example.net' }
  )
  assert.deepEqual(
    classifyAttachmentSource({ remoteUrl: 'https://lovethewind.cn.example.net/a.png', serverSourceId: null }, settings),
    { sourceKind: 'external-cache', sourceHost: 'lovethewind.cn.example.net' }
  )
})
