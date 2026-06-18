/** "Sales Order Item" -> "sales_order_item" (table name) */
export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

/** "Sales Order Item" -> "SalesOrderItem" (TS interface name) */
export function pascalCase(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}
