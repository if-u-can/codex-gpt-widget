function workAreaInViewport(bounds, area) {
  if (![bounds, area].every(rect => rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0)) return null;
  const limit = (value, max) => Math.max(0, Math.min(max, value));
  const left = limit(area.x - bounds.x, bounds.width), top = limit(area.y - bounds.y, bounds.height);
  return { left, top, right: Math.max(left, limit(area.x + area.width - bounds.x, bounds.width)), bottom: Math.max(top, limit(area.y + area.height - bounds.y, bounds.height)) };
}
module.exports = { workAreaInViewport };
