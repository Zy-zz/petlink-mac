function clampBounds(bounds, area) {
  return { ...bounds,
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + Math.max(0, area.width - bounds.width)))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + Math.max(0, area.height - bounds.height)))) };
}
function placedBounds(placement, displays, size) {
  const area = (displays[placement.display - 1] || displays[0]).workArea;
  return clampBounds({ ...size, x: area.x + placement.x * area.width - size.width / 2,
    y: area.y + placement.y * area.height - size.height / 2 }, area);
}
module.exports = { clampBounds, placedBounds };
