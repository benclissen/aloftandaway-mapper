import { MAP_DATA_ERROR } from '../../core/index.js'

/** The two methods of MapLibre's event emitter that `waitForStyleLoad` uses. */
export interface StyleEvents {
  on(type: 'style.load' | 'error', listener: () => void): unknown
  off(type: 'style.load' | 'error', listener: () => void): unknown
}

/**
 * Resolves on the map's next `style.load`. Rejects on a map `error` event first, with the error `throwMapError` throws
 * (the map-data error), or if the style has not loaded after `timeoutMs`. Call it before `setStyle`, so the event
 * can't be missed. Both listeners are gone once it settles.
 */
export function waitForStyleLoad(map: StyleEvents, timeoutMs: number, throwMapError: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      map.off('style.load', onLoad)
      map.off('error', onError)
    }
    const onLoad = () => {
      done()
      resolve()
    }
    const onError = () => {
      done()
      try {
        throwMapError()
        // The stage records an error before this listener runs, so there is always one to throw. If it was already
        // taken, the style still can't be trusted.
        reject(new Error(`${MAP_DATA_ERROR} the map style failed to load.`))
      } catch (e) {
        reject(e as Error)
      }
    }
    const timer = setTimeout(() => {
      done()
      reject(new Error(`${MAP_DATA_ERROR} the map style did not load within ${timeoutMs / 1000} s.`))
    }, timeoutMs)
    map.on('style.load', onLoad)
    map.on('error', onError)
  })
}
