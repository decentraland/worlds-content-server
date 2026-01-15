import {
  createCoordinatesComponent,
  ICoordinatesComponent,
  Coordinate,
  BoundingRectangle
} from '../../src/logic/coordinates'
import { Entity, EntityType } from '@dcl/schemas'

describe('CoordinatesComponent', () => {
  let coordinatesComponent: ICoordinatesComponent

  beforeEach(() => {
    coordinatesComponent = createCoordinatesComponent()
  })

  describe('when parsing coordinates', () => {
    describe('when the coordinate string is valid', () => {
      describe('and the coordinates are positive', () => {
        let coordinateString: string
        let result: Coordinate

        beforeEach(() => {
          coordinateString = '10,20'
          result = coordinatesComponent.parseCoordinate(coordinateString)
        })

        it('should return the correct x value', () => {
          expect(result.x).toBe(10)
        })

        it('should return the correct y value', () => {
          expect(result.y).toBe(20)
        })
      })

      describe('and the coordinates are negative', () => {
        let coordinateString: string
        let result: Coordinate

        beforeEach(() => {
          coordinateString = '-5,-10'
          result = coordinatesComponent.parseCoordinate(coordinateString)
        })

        it('should return the correct x value', () => {
          expect(result.x).toBe(-5)
        })

        it('should return the correct y value', () => {
          expect(result.y).toBe(-10)
        })
      })

      describe('and the coordinates are mixed', () => {
        let coordinateString: string
        let result: Coordinate

        beforeEach(() => {
          coordinateString = '-5,10'
          result = coordinatesComponent.parseCoordinate(coordinateString)
        })

        it('should return the correct x value', () => {
          expect(result.x).toBe(-5)
        })

        it('should return the correct y value', () => {
          expect(result.y).toBe(10)
        })
      })

      describe('and the coordinates are zero', () => {
        let coordinateString: string
        let result: Coordinate

        beforeEach(() => {
          coordinateString = '0,0'
          result = coordinatesComponent.parseCoordinate(coordinateString)
        })

        it('should return zero for x', () => {
          expect(result.x).toBe(0)
        })

        it('should return zero for y', () => {
          expect(result.y).toBe(0)
        })
      })
    })

    describe('when the coordinate string is invalid', () => {
      describe('and the format is invalid', () => {
        let coordinateString: string

        beforeEach(() => {
          coordinateString = 'invalid'
        })

        it('should throw an error with the correct message', () => {
          expect(() => coordinatesComponent.parseCoordinate(coordinateString)).toThrow(
            'Invalid coordinate format: invalid'
          )
        })
      })

      describe('and the y coordinate is missing', () => {
        let coordinateString: string

        beforeEach(() => {
          coordinateString = '10'
        })

        it('should throw an error with the correct message', () => {
          expect(() => coordinatesComponent.parseCoordinate(coordinateString)).toThrow('Invalid coordinate format: 10')
        })
      })

      describe('and the values are non-numeric', () => {
        let coordinateString: string

        beforeEach(() => {
          coordinateString = 'a,b'
        })

        it('should throw an error with the correct message', () => {
          expect(() => coordinatesComponent.parseCoordinate(coordinateString)).toThrow('Invalid coordinate values: a,b')
        })
      })

      describe('and the string is empty', () => {
        let coordinateString: string

        beforeEach(() => {
          coordinateString = ''
        })

        it('should throw an error with the correct message', () => {
          expect(() => coordinatesComponent.parseCoordinate(coordinateString)).toThrow('Invalid coordinate format: ')
        })
      })
    })
  })

  describe('when calculating the bounding rectangle', () => {
    describe('and the parcels array is empty', () => {
      let parcels: string[]
      let result: BoundingRectangle | undefined

      beforeEach(() => {
        parcels = []
        result = coordinatesComponent.calculateBoundingRectangle(parcels)
      })

      it('should return undefined', () => {
        expect(result).toBeUndefined()
      })
    })

    describe('and the parcels array has one parcel', () => {
      let parcels: string[]
      let result: BoundingRectangle | undefined

      beforeEach(() => {
        parcels = ['10,20']
        result = coordinatesComponent.calculateBoundingRectangle(parcels)
      })

      it('should return a rectangle with same min and max x', () => {
        expect(result?.min.x).toBe(10)
        expect(result?.max.x).toBe(10)
      })

      it('should return a rectangle with same min and max y', () => {
        expect(result?.min.y).toBe(20)
        expect(result?.max.y).toBe(20)
      })
    })

    describe('and the parcels array has multiple parcels', () => {
      let parcels: string[]
      let result: BoundingRectangle | undefined

      beforeEach(() => {
        parcels = ['0,0', '5,10', '-3,7']
        result = coordinatesComponent.calculateBoundingRectangle(parcels)
      })

      it('should return the correct min x', () => {
        expect(result?.min.x).toBe(-3)
      })

      it('should return the correct max x', () => {
        expect(result?.max.x).toBe(5)
      })

      it('should return the correct min y', () => {
        expect(result?.min.y).toBe(0)
      })

      it('should return the correct max y', () => {
        expect(result?.max.y).toBe(10)
      })
    })

    describe('and the parcels have negative coordinates', () => {
      let parcels: string[]
      let result: BoundingRectangle | undefined

      beforeEach(() => {
        parcels = ['-10,-20', '-5,-10', '-15,-5']
        result = coordinatesComponent.calculateBoundingRectangle(parcels)
      })

      it('should return the correct min x', () => {
        expect(result?.min.x).toBe(-15)
      })

      it('should return the correct max x', () => {
        expect(result?.max.x).toBe(-5)
      })

      it('should return the correct min y', () => {
        expect(result?.min.y).toBe(-20)
      })

      it('should return the correct max y', () => {
        expect(result?.max.y).toBe(-5)
      })
    })
  })

  describe('when checking if a coordinate is within the rectangle', () => {
    describe('and the coordinate is inside the rectangle', () => {
      let coordinate: Coordinate
      let rectangle: BoundingRectangle
      let result: boolean

      beforeEach(() => {
        coordinate = { x: 5, y: 5 }
        rectangle = { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
        result = coordinatesComponent.isCoordinateWithinRectangle(coordinate, rectangle)
      })

      it('should return true', () => {
        expect(result).toBe(true)
      })
    })

    describe('and the coordinate is on the rectangle boundary', () => {
      describe('and the coordinate is on the min boundary', () => {
        let coordinate: Coordinate
        let rectangle: BoundingRectangle
        let result: boolean

        beforeEach(() => {
          coordinate = { x: 0, y: 0 }
          rectangle = { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
          result = coordinatesComponent.isCoordinateWithinRectangle(coordinate, rectangle)
        })

        it('should return true', () => {
          expect(result).toBe(true)
        })
      })

      describe('and the coordinate is on the max boundary', () => {
        let coordinate: Coordinate
        let rectangle: BoundingRectangle
        let result: boolean

        beforeEach(() => {
          coordinate = { x: 10, y: 10 }
          rectangle = { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
          result = coordinatesComponent.isCoordinateWithinRectangle(coordinate, rectangle)
        })

        it('should return true', () => {
          expect(result).toBe(true)
        })
      })
    })

    describe('and the coordinate is outside the rectangle', () => {
      describe('and x is too small', () => {
        let coordinate: Coordinate
        let rectangle: BoundingRectangle
        let result: boolean

        beforeEach(() => {
          coordinate = { x: -1, y: 5 }
          rectangle = { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
          result = coordinatesComponent.isCoordinateWithinRectangle(coordinate, rectangle)
        })

        it('should return false', () => {
          expect(result).toBe(false)
        })
      })

      describe('and x is too large', () => {
        let coordinate: Coordinate
        let rectangle: BoundingRectangle
        let result: boolean

        beforeEach(() => {
          coordinate = { x: 11, y: 5 }
          rectangle = { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
          result = coordinatesComponent.isCoordinateWithinRectangle(coordinate, rectangle)
        })

        it('should return false', () => {
          expect(result).toBe(false)
        })
      })

      describe('and y is too small', () => {
        let coordinate: Coordinate
        let rectangle: BoundingRectangle
        let result: boolean

        beforeEach(() => {
          coordinate = { x: 5, y: -1 }
          rectangle = { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
          result = coordinatesComponent.isCoordinateWithinRectangle(coordinate, rectangle)
        })

        it('should return false', () => {
          expect(result).toBe(false)
        })
      })

      describe('and y is too large', () => {
        let coordinate: Coordinate
        let rectangle: BoundingRectangle
        let result: boolean

        beforeEach(() => {
          coordinate = { x: 5, y: 11 }
          rectangle = { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
          result = coordinatesComponent.isCoordinateWithinRectangle(coordinate, rectangle)
        })

        it('should return false', () => {
          expect(result).toBe(false)
        })
      })
    })

    describe('and the coordinates are negative', () => {
      let coordinate: Coordinate
      let rectangle: BoundingRectangle
      let result: boolean

      beforeEach(() => {
        coordinate = { x: -5, y: -5 }
        rectangle = { min: { x: -10, y: -10 }, max: { x: 0, y: 0 } }
        result = coordinatesComponent.isCoordinateWithinRectangle(coordinate, rectangle)
      })

      it('should return true', () => {
        expect(result).toBe(true)
      })
    })
  })

  describe('when extracting the spawn coordinates', () => {
    describe('and the entity has a scene.base', () => {
      let entity: Entity
      let result: string

      beforeEach(() => {
        entity = {
          id: 'bafi',
          version: 'v3',
          type: EntityType.SCENE,
          pointers: ['10,20'],
          timestamp: 1689683357974,
          content: [],
          metadata: {
            scene: { base: '10,20', parcels: ['10,20', '11,20'] }
          }
        }
        result = coordinatesComponent.extractSpawnCoordinates(entity)
      })

      it('should return the scene.base coordinate', () => {
        expect(result).toBe('10,20')
      })
    })

    describe('and the entity has only scene.parcels and no scene.base', () => {
      let entity: Entity
      let result: string

      beforeEach(() => {
        entity = {
          id: 'bafi',
          version: 'v3',
          type: EntityType.SCENE,
          pointers: ['5,10'],
          timestamp: 1689683357974,
          content: [],
          metadata: {
            scene: { parcels: ['5,10', '6,10'] }
          }
        }
        result = coordinatesComponent.extractSpawnCoordinates(entity)
      })

      it('should return the first parcel from scene.parcels', () => {
        expect(result).toBe('5,10')
      })
    })

    describe('and the entity has negative coordinates', () => {
      let entity: Entity
      let result: string

      beforeEach(() => {
        entity = {
          id: 'bafi',
          version: 'v3',
          type: EntityType.SCENE,
          pointers: ['-5,-10'],
          timestamp: 1689683357974,
          content: [],
          metadata: {
            scene: { base: '-5,-10', parcels: ['-5,-10'] }
          }
        }
        result = coordinatesComponent.extractSpawnCoordinates(entity)
      })

      it('should return the negative coordinate', () => {
        expect(result).toBe('-5,-10')
      })
    })

    describe('and the entity has no scene metadata', () => {
      let entity: Entity

      beforeEach(() => {
        entity = {
          id: 'bafi',
          version: 'v3',
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: 1689683357974,
          content: [],
          metadata: {}
        }
      })

      it('should throw an error', () => {
        expect(() => coordinatesComponent.extractSpawnCoordinates(entity)).toThrow(
          'No spawn coordinates found in entity metadata'
        )
      })
    })

    describe('and the entity has empty scene.parcels and no scene.base', () => {
      let entity: Entity

      beforeEach(() => {
        entity = {
          id: 'bafi',
          version: 'v3',
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: 1689683357974,
          content: [],
          metadata: {
            scene: { parcels: [] }
          }
        }
      })

      it('should throw an error', () => {
        expect(() => coordinatesComponent.extractSpawnCoordinates(entity)).toThrow(
          'No spawn coordinates found in entity metadata'
        )
      })
    })

    describe('and the entity has undefined metadata', () => {
      let entity: Entity

      beforeEach(() => {
        entity = {
          id: 'bafi',
          version: 'v3',
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: 1689683357974,
          content: []
        }
      })

      it('should throw an error', () => {
        expect(() => coordinatesComponent.extractSpawnCoordinates(entity)).toThrow(
          'No spawn coordinates found in entity metadata'
        )
      })
    })
  })

  describe('when getting the center of a rectangle', () => {
    describe('and the rectangle has positive coordinates', () => {
      let rectangle: BoundingRectangle
      let result: Coordinate

      beforeEach(() => {
        rectangle = { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }
        result = coordinatesComponent.getRectangleCenter(rectangle)
      })

      it('should return the correct center x', () => {
        expect(result.x).toBe(5)
      })

      it('should return the correct center y', () => {
        expect(result.y).toBe(5)
      })
    })

    describe('and the rectangle has negative coordinates', () => {
      let rectangle: BoundingRectangle
      let result: Coordinate

      beforeEach(() => {
        rectangle = { min: { x: -10, y: -10 }, max: { x: 0, y: 0 } }
        result = coordinatesComponent.getRectangleCenter(rectangle)
      })

      it('should return the correct center x', () => {
        expect(result.x).toBe(-5)
      })

      it('should return the correct center y', () => {
        expect(result.y).toBe(-5)
      })
    })

    describe('and the rectangle spans positive and negative coordinates', () => {
      let rectangle: BoundingRectangle
      let result: Coordinate

      beforeEach(() => {
        rectangle = { min: { x: -5, y: -3 }, max: { x: 5, y: 7 } }
        result = coordinatesComponent.getRectangleCenter(rectangle)
      })

      it('should return the correct center x', () => {
        expect(result.x).toBe(0)
      })

      it('should return the correct center y', () => {
        expect(result.y).toBe(2)
      })
    })

    describe('and the center is not an integer', () => {
      let rectangle: BoundingRectangle
      let result: Coordinate

      beforeEach(() => {
        rectangle = { min: { x: 0, y: 0 }, max: { x: 5, y: 5 } }
        result = coordinatesComponent.getRectangleCenter(rectangle)
      })

      it('should floor the center x', () => {
        expect(result.x).toBe(2)
      })

      it('should floor the center y', () => {
        expect(result.y).toBe(2)
      })
    })

    describe('and the rectangle is a single point', () => {
      let rectangle: BoundingRectangle
      let result: Coordinate

      beforeEach(() => {
        rectangle = { min: { x: 5, y: 5 }, max: { x: 5, y: 5 } }
        result = coordinatesComponent.getRectangleCenter(rectangle)
      })

      it('should return the same point as center x', () => {
        expect(result.x).toBe(5)
      })

      it('should return the same point as center y', () => {
        expect(result.y).toBe(5)
      })
    })
  })
})
