/**
 * 生成图 IndexedDB 缓存（简单封装）。
 * db: rhinestone-studio / store: images {id, blob, createdAt}
 */

const DB_NAME = 'rhinestone-studio'
const DB_VERSION = 1
const STORE_NAME = 'images'

export interface StoredImage {
  id: string
  blob: Blob
  createdAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB 不可用。'))
  }
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // 连接被浏览器后台关闭时允许下次重连。
      db.onclose = () => {
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      dbPromise = null
      reject(request.error ?? new Error('IndexedDB 打开失败。'))
    }
  })
  return dbPromise
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let request: IDBRequest<T>
        try {
          const tx = db.transaction(STORE_NAME, mode)
          const store = tx.objectStore(STORE_NAME)
          request = run(store)
        } catch (error) {
          dbPromise = null
          reject(error)
          return
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }),
  )
}

export async function putImage(id: string, blob: Blob): Promise<void> {
  await withStore('readwrite', (store) => store.put({ id, blob, createdAt: Date.now() } satisfies StoredImage))
}

export async function getImageBlob(id: string): Promise<Blob | null> {
  const record = await withStore<StoredImage | undefined>('readonly', (store) => store.get(id))
  return record?.blob ?? null
}

export async function deleteImage(id: string): Promise<void> {
  await withStore<undefined>('readwrite', (store) => store.delete(id))
}

export async function listImages(): Promise<StoredImage[]> {
  const records = await withStore<StoredImage[]>('readonly', (store) => store.getAll())
  return records.sort((a, b) => a.createdAt - b.createdAt)
}

// ---------------------------------------------------------------------------
// 数据 URL / Blob 互转（送转化与恢复显示用）
// ---------------------------------------------------------------------------

export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) throw new Error('非法 data URL。')
  const header = dataUrl.slice(0, commaIndex)
  const body = dataUrl.slice(commaIndex + 1)
  const mimeType = header.match(/^data:([^;,]+)/)?.[1] || 'image/png'
  const isBase64 = /;base64/i.test(header)
  if (!isBase64) {
    return new Blob([decodeURIComponent(body)], { type: mimeType })
  }
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('blobToDataUrl 结果异常。'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader 读取失败。'))
    reader.readAsDataURL(blob)
  })
}

/** http(s) URL 或 data URL 统一转 Blob（data 直接解码，http 走 fetch）。 */
export async function imageUrlToBlob(imageUrl: string, signal?: AbortSignal): Promise<Blob> {
  if (imageUrl.startsWith('data:')) return dataUrlToBlob(imageUrl)
  const res = await fetch(imageUrl, { signal })
  if (!res.ok) throw new Error(`结果图下载失败，HTTP ${res.status}`)
  return res.blob()
}
