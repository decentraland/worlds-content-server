import { Entity } from '@dcl/schemas'

/**
 * Represents a coordinate point with x and y values
 */
export type Coordinate = {
  x: number
  y: number
}

/**
 * Represents a bounding rectangle defined by min and max coordinates
 */
export type BoundingRectangle = {
  min: Coordinate
  max: Coordinate
}

export type ICoordinatesComponent = {
  /**
   * Parses a coordinate string (e.g., "10,20" or "-5,-10") into a Coordinate object
   *
   * @param coordinateString - The coordinate string to parse
   * @returns The parsed Coordinate object
   * @throws {Error} If the coordinate string is invalid
   */
  parseCoordinate(coordinateString: string): Coordinate

  /**
   * Calculates the bounding rectangle that encompasses all given parcels
   *
   * @param parcels - Array of parcel coordinate strings (e.g., ["0,0", "1,0", "-1,2"])
   * @returns The bounding rectangle, or undefined if no parcels are provided
   */
  calculateBoundingRectangle(parcels: string[]): BoundingRectangle | undefined

  /**
   * Checks if a coordinate is within the given bounding rectangle (inclusive)
   *
   * @param coordinate - The coordinate to check
   * @param rectangle - The bounding rectangle
   * @returns true if the coordinate is within the rectangle, false otherwise
   */
  isCoordinateWithinRectangle(coordinate: Coordinate, rectangle: BoundingRectangle): boolean

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
  extractSpawnCoordinates(entity: Entity): string

  /**
   * Calculates the center coordinate of a bounding rectangle
   *
   * @param rectangle - The bounding rectangle
   * @returns The center coordinate (floored to integers)
   */
  getRectangleCenter(rectangle: BoundingRectangle): Coordinate

  /**
   * Compares two coordinates for equality
   *
   * @param a - First coordinate (can be null)
   * @param b - Second coordinate (can be null)
   * @returns true if both coordinates are equal (or both are null), false otherwise
   */
  areCoordinatesEqual(a: Coordinate | null, b: Coordinate | null): boolean
}
