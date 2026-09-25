// Ordered sidebar arrays are immutable React inputs. Cache their first index
// once per identity instead of scanning the list from every sortable row.
const indices = new WeakMap();

export function sidebarItemIndex(items, key) {
  if (items == null) return -1;
  let index = indices.get(items);
  if (!index) {
    index = new Map();
    for (let i = 0; i < items.length; i++) {
      if (!index.has(items[i])) index.set(items[i], i);
    }
    indices.set(items, index);
  }
  return index.get(key) ?? -1;
}
