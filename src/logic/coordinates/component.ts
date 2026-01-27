import { Entity } from '@dcl/schemas'
import { BoundingRectangle, Coordinate, ICoordinatesComponent } from './types'

const MIN_PARCEL_COORDINATE = -150
const MAX_PARCEL_COORDINATE = 150

export function createCoordinatesComponent(): ICoordinatesComponent {
  /**
   * Parses a coordinate string (e.g., "10,20" or "-5,-10") into a Coordinate object
   *
   * @param coordinateString - The coordinate string to parse
   * @returns The parsed Coordinate object
   * @throws {Error} If the coordinate string is invalid or out of bounds
   */
  function parseCoordinate(coordinateString: string): Coordinate {
    const parts = coordinateString.split(',')
    if (parts.length !== 2) {
      throw new Error(`Invalid coordinate format: ${coordinateString}`)
    }

    const x = parseInt(parts[0], 10)
    const y = parseInt(parts[1], 10)

    if (isNaN(x) || isNaN(y)) {
      throw new Error(`Invalid coordinate values: ${coordinateString}`)
    }

    if (x < MIN_PARCEL_COORDINATE || x > MAX_PARCEL_COORDINATE) {
      throw new Error(
        `Coordinate X value ${x} is out of bounds. Must be between ${MIN_PARCEL_COORDINATE} and ${MAX_PARCEL_COORDINATE}.`
      )
    }

    if (y < MIN_PARCEL_COORDINATE || y > MAX_PARCEL_COORDINATE) {
      throw new Error(
        `Coordinate Y value ${y} is out of bounds. Must be between ${MIN_PARCEL_COORDINATE} and ${MAX_PARCEL_COORDINATE}.`
      )
    }

    return { x, y }
  }

  /**
   * Calculates the bounding rectangle that encompasses all given parcels
   *
   * @param parcels - Array of parcel coordinate strings (e.g., ["0,0", "1,0", "-1,2"])
   * @returns The bounding rectangle, or undefined if no parcels are provided
   */
  function calculateBoundingRectangle(parcels: string[]): BoundingRectangle | undefined {
    if (parcels.length === 0) {
      return undefined
    }

    const coordinates = parcels.map(parseCoordinate)

    const minX = Math.min(...coordinates.map((c) => c.x))
    const maxX = Math.max(...coordinates.map((c) => c.x))
    const minY = Math.min(...coordinates.map((c) => c.y))
    const maxY = Math.max(...coordinates.map((c) => c.y))

    return {
      min: { x: minX, y: minY },
      max: { x: maxX, y: maxY }
    }
  }

  /**
   * Checks if a coordinate is within the given bounding rectangle (inclusive)
   *
   * @param coordinate - The coordinate to check
   * @param rectangle - The bounding rectangle
   * @returns true if the coordinate is within the rectangle, false otherwise
   */
  function isCoordinateWithinRectangle(coordinate: Coordinate, rectangle: BoundingRectangle): boolean {
    return (
      coordinate.x >= rectangle.min.x &&
      coordinate.x <= rectangle.max.x &&
      coordinate.y >= rectangle.min.y &&
      coordinate.y <= rectangle.max.y
    )
  }

  /**
   * Extracts the spawn point parcel coordinate from an Entity's metadata
   *
   * The spawn coordinate is determined using the following priority:
   * 1. The scene's base parcel (scene.base)
   * 2. The first parcel in the scene's parcels array (scene.parcels[0])
   *
   * @param entity - The scene entity containing metadata with scene information
   * @returns The parcel coordinate string (e.g., "0,0")
   * @throws {Error} If no valid spawn coordinates are found in the entity metadata
   */
  function extractSpawnCoordinates(entity: Entity): string {
    const scene = entity.metadata?.scene
    const parcel = scene?.base || (scene?.parcels && scene.parcels[0])
    if (parcel && typeof parcel === 'string') {
      return parcel
    }

    throw new Error('No spawn coordinates found in entity metadata')
  }

  /**
   * Calculates the center coordinate of a bounding rectangle
   *
   * @param rectangle - The bounding rectangle
   * @returns The center coordinate (floored to integers)
   */
  function getRectangleCenter(rectangle: BoundingRectangle): Coordinate {
    return {
      x: Math.floor((rectangle.min.x + rectangle.max.x) / 2),
      y: Math.floor((rectangle.min.y + rectangle.max.y) / 2)
    }
  }

  /**
   * Compares two coordinates for equality
   *
   * @param a - First coordinate (can be null)
   * @param b - Second coordinate (can be null)
   * @returns true if both coordinates are equal (or both are null), false otherwise
   */
  function areCoordinatesEqual(a: Coordinate | null, b: Coordinate | null): boolean {
    if (a === null && b === null) {
      return true
    }
    if (a === null || b === null) {
      return false
    }
    return a.x === b.x && a.y === b.y
  }

  return {
    parseCoordinate,
    calculateBoundingRectangle,
    isCoordinateWithinRectangle,
    extractSpawnCoordinates,
    getRectangleCenter,
    areCoordinatesEqual
  }
}
