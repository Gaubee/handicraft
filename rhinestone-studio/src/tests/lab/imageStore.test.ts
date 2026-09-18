import { beforeEach, describe, expect, it } from 'vitest'
import {
  blobToDataUrl,
  dataUrlToBlob,
  deleteImage,
  getImageBlob,
  imageUrlToBlob,
  listImages,
  putImage,
} from '$lib/persistence/imageStore'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

let fake: FakeIndexedDB

beforeEach(() => {
  fake = installFakeIndexedDB()
  fake.reset()
})

describe('IndexedDB 图片缓存（db: rhinestone-studio / store: images）', () => {
  it('put/get roundtrip', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    await putImage('task-1', blob)
    const restored = await getImageBlob('task-1')
    expect(restored).toBeInstanceOf(Blob)
    expect(restored?.size).toBe(3)
    expect(restored?.type).toBe('image/png')
  })

  it('get 缺失 id 返回 null', async () => {
    expect(await getImageBlob('missing')).toBeNull()
  })

  it('delete 后取不到', async () => {
    await putImage('task-1', new Blob(['a']))
    await deleteImage('task-1')
    expect(await getImageBlob('task-1')).toBeNull()
  })

  it('listImages 返回全部记录', async () => {
    await putImage('a', new Blob(['a']))
    await putImage('b', new Blob(['b']))
    const all = await listImages()
    expect(all).toHaveLength(2)
    expect(all.map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('reset（连接关闭）后可重新打开', async () => {
    await putImage('a', new Blob(['a']))
    fake.reset()
    const all = await listImages()
    expect(all).toHaveLength(0)
  })
})

describe('数据 URL / Blob 互转', () => {
  it('dataUrlToBlob base64 解码', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,QUJD')
    expect(blob.type).toBe('image/png')
    expect(await blob.text()).toBe('ABC')
  })

  it('dataUrlToBlob 非 base64 分支', async () => {
    const blob = dataUrlToBlob(`data:text/plain,${encodeURIComponent('你好')}`)
    expect(await blob.text()).toBe('你好')
  })

  it('blobToDataUrl roundtrip', async () => {
    const original = new Blob([new Uint8Array([104, 105])], { type: 'image/png' })
    const dataUrl = await blobToDataUrl(original)
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    const restored = dataUrlToBlob(dataUrl)
    expect(await restored.text()).toBe('hi')
  })

  it('imageUrlToBlob 的 data: 分支直接解码', async () => {
    const blob = await imageUrlToBlob('data:image/png;base64,QUJDRA==')
    expect(await blob.text()).toBe('ABCD')
  })
})
