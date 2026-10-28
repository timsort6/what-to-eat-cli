// 高德地图外链只由已校验的 POI ID 或 GCJ-02 坐标生成；固定 origin，从不接受模型或原始数据提供的 URL。
const ORIGIN = 'https://uri.amap.com'
const POI_ID = /^[A-Za-z0-9]{1,64}$/
const DEGREE = /^-?\d{1,3}(?:\.\d+)?$/

export type MapLink = Readonly<{ kind: 'detail' | 'position'; href: string }>
export type MapLinkSource = Readonly<{ id: string; name: string; location: string }>

// 候选稳定键（poi:/synthetic:）含冒号，天然不满足 POI ID 规则。
function poiID(id: string): string | null {
  const trimmed = id.trim()
  return POI_ID.test(trimmed) ? trimmed : null
}

function gcj02(location: string): string | null {
  const parts = location.split(',')
  if (parts.length !== 2 || !parts.every((part) => DEGREE.test(part))) return null
  const [lon, lat] = parts.map(Number) as [number, number]
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null
  // 沿用已校验的原字符串：Number 再字符串化会把极小值写成 1e-7 这类指数形式。
  return location
}

export function amapLink(place: MapLinkSource): MapLink | null {
  const id = poiID(place.id)
  if (id) {
    const url = new URL('/poidetail', ORIGIN)
    url.search = new URLSearchParams({ poiid: id, callnative: '0' }).toString()
    return { kind: 'detail', href: url.href }
  }
  const position = gcj02(place.location)
  if (!position) return null
  const url = new URL('/marker', ORIGIN)
  // position 只含数字、点、负号与逗号，保留高德文档的逗号写法；其余参数统一由 URLSearchParams 编码。
  url.search = `position=${position}&${new URLSearchParams({ name: place.name.trim() || '推荐地点', coordinate: 'gaode', callnative: '0' })}`
  return { kind: 'position', href: url.href }
}
