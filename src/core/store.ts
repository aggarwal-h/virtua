import {
  findStartIndexWithOffset,
  resetCache,
  getItemSize,
  computeTotalSize,
  findEndIndex,
  computeStartOffset,
  Cache,
  UNCACHED,
  setItemSize,
  hasUnmeasuredItemsInRange,
} from "./cache";
import type { Writeable } from "./types";

export type ScrollJump = Readonly<[index: number, sizeDiff: number][]>;
export type ItemResize = [index: number, size: number];
type ItemsRange = [startIndex: number, endIndex: number];

export const ACTION_UPDATE_ITEM_SIZES = 1;
export const ACTION_UPDATE_VIEWPORT = 2;
export const ACTION_HANDLE_SCROLL = 3;

type Actions =
  | [type: typeof ACTION_UPDATE_ITEM_SIZES, entries: ItemResize[]]
  | [
      type: typeof ACTION_UPDATE_VIEWPORT,
      rect: { _width: number; _height: number }
    ]
  | [type: typeof ACTION_HANDLE_SCROLL, offset: number];

export type VirtualStore = {
  _getRange(): ItemsRange;
  _isUnmeasuredItem(index: number): boolean;
  _hasUnmeasuredItemsInRange(startIndex: number): boolean;
  _getItemOffset(index: number): number;
  _getScrollOffset(): number;
  _getViewportSize(): number;
  _getScrollSize(): number;
  _getJump(): ScrollJump;
  _isHorizontal(): boolean;
  _isRtl(): boolean;
  _getItemIndexForScrollTo(offset: number): number;
  _waitForScrollDestinationItemsMeasured(): Promise<void>;
  _subscribe(cb: () => void): () => void;
  _update(...action: Actions): void;
  _updateCacheLength(length: number): void;
};

export const createVirtualStore = (
  itemCount: number,
  itemSize: number,
  isHorizontal: boolean,
  isRtl: boolean
): VirtualStore => {
  let viewportWidth = 0;
  let viewportHeight = 0;
  let scrollOffset = 0;
  let jump: ScrollJump = [];
  let cache = resetCache(itemCount, itemSize);
  let _prevRange: ItemsRange = [0, 0];
  let _scrollToQueue: [() => void, () => void] | undefined;

  const subscribers = new Set<() => void>();
  const getViewportSize = (): number =>
    isHorizontal ? viewportWidth : viewportHeight;

  return {
    _getRange() {
      const [prevStartIndex, prevEndIndex] = _prevRange;
      const prevOffset = computeStartOffset(
        cache as Writeable<Cache>,
        prevStartIndex
      );
      const start = findStartIndexWithOffset(
        cache,
        scrollOffset,
        prevStartIndex,
        prevOffset
      );
      const end = findEndIndex(cache, start, getViewportSize());
      if (prevStartIndex === start && prevEndIndex === end) {
        return _prevRange;
      }
      return (_prevRange = [start, end]);
    },
    _isUnmeasuredItem(index) {
      return cache._sizes[index] === UNCACHED;
    },
    _hasUnmeasuredItemsInRange(startIndex) {
      return hasUnmeasuredItemsInRange(
        cache,
        startIndex,
        findEndIndex(cache, startIndex, getViewportSize())
      );
    },
    _getItemOffset(index) {
      return computeStartOffset(cache as Writeable<Cache>, index);
    },
    _getScrollOffset() {
      return scrollOffset;
    },
    _getViewportSize() {
      return getViewportSize();
    },
    _getScrollSize() {
      return computeTotalSize(cache as Writeable<Cache>);
    },
    _getJump() {
      return jump;
    },
    _isHorizontal() {
      return isHorizontal;
    },
    _isRtl() {
      return isRtl;
    },
    _getItemIndexForScrollTo(offset) {
      return findStartIndexWithOffset(cache, offset, 0, 0);
    },
    _waitForScrollDestinationItemsMeasured() {
      if (_scrollToQueue) {
        // Cancel waiting scrollTo
        _scrollToQueue[1]();
      }
      // The measurement will be done asynchronously and the timing is not predictable so we use promise.
      // For example, ResizeObserver may not fire when window is not visible.
      return new Promise((resolve, reject) => {
        _scrollToQueue = [
          () => {
            // HACK: It should be resolved in the next microtask that is after React's render
            Promise.resolve().then(() => {
              resolve();
              _scrollToQueue = undefined;
            });
          },
          reject,
        ];
      });
    },
    _subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    _update(type, payload) {
      const mutated = ((): boolean => {
        switch (type) {
          case ACTION_UPDATE_ITEM_SIZES: {
            const updated = payload.filter(
              ([index, size]) => cache._sizes[index] !== size
            );
            // Skip if all items are cached and not updated
            if (!updated.length) {
              return false;
            }

            const updatedJump: [index: number, sizeDiff: number][] = [];
            updated.forEach(([index, size]) => {
              updatedJump.push([index, size - getItemSize(cache, index)]);
              setItemSize(cache as Writeable<Cache>, index, size);
            });
            jump = updatedJump;
            return true;
          }
          case ACTION_UPDATE_VIEWPORT: {
            if (
              viewportWidth === payload._width &&
              viewportHeight === payload._height
            ) {
              return false;
            }
            viewportWidth = payload._width;
            viewportHeight = payload._height;
            return true;
          }
          case ACTION_HANDLE_SCROLL: {
            const prevOffset = scrollOffset;
            return (scrollOffset = payload) !== prevOffset;
          }
        }
      })();

      if (mutated) {
        subscribers.forEach((cb) => {
          cb();
        });
        if (_scrollToQueue && type === ACTION_UPDATE_ITEM_SIZES) {
          _scrollToQueue[0]();
        }
      }
    },
    _updateCacheLength(length) {
      // It's ok to be updated in render because states should be calculated consistently regardless cache length
      if (cache._length === length) return;
      cache = resetCache(length, itemSize, cache);
    },
  };
};
