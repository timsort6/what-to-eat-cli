const PI = Math.PI
const AXIS = 6378245.0
const ECCENTRICITY_SQUARED = 0.00669342162296594323

function transformLatitude(longitude: number, latitude: number): number {
  let value = -100 + 2 * longitude + 3 * latitude + 0.2 * latitude * latitude
    + 0.1 * longitude * latitude + 0.2 * Math.sqrt(Math.abs(longitude))
  value += (20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2 / 3
  value += (20 * Math.sin(latitude * PI) + 40 * Math.sin(latitude / 3 * PI)) * 2 / 3
  value += (160 * Math.sin(latitude / 12 * PI) + 320 * Math.sin(latitude * PI / 30)) * 2 / 3
  return value
}

function transformLongitude(longitude: number, latitude: number): number {
  let value = 300 + longitude + 2 * latitude + 0.1 * longitude * longitude
    + 0.1 * longitude * latitude + 0.1 * Math.sqrt(Math.abs(longitude))
  value += (20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2 / 3
  value += (20 * Math.sin(longitude * PI) + 40 * Math.sin(longitude / 3 * PI)) * 2 / 3
  value += (150 * Math.sin(longitude / 12 * PI) + 300 * Math.sin(longitude / 30 * PI)) * 2 / 3
  return value
}

export function wgs84ToGcj02(longitude: number, latitude: number): string {
  if (longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271) {
    return `${longitude},${latitude}`
  }

  const latitudeRadians = latitude / 180 * PI
  let latitudeOffset = transformLatitude(longitude - 105, latitude - 35)
  let longitudeOffset = transformLongitude(longitude - 105, latitude - 35)
  const sine = Math.sin(latitudeRadians)
  const magic = 1 - ECCENTRICITY_SQUARED * sine * sine
  const root = Math.sqrt(magic)
  latitudeOffset = latitudeOffset * 180 / ((AXIS * (1 - ECCENTRICITY_SQUARED)) / (magic * root) * PI)
  longitudeOffset = longitudeOffset * 180 / (AXIS / root * Math.cos(latitudeRadians) * PI)
  return `${(longitude + longitudeOffset).toFixed(6)},${(latitude + latitudeOffset).toFixed(6)}`
}
