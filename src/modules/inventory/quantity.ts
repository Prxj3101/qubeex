// Stock quantities: consumables (paper, ink, litres, kilograms) may use up to 3 decimal places,
// matching the Decimal(14, 3) database column. Equipment and fixed assets always stay whole numbers.
export const QUANTITY_PATTERN = /^\d{1,10}(\.\d{1,3})?$/;
export const QUANTITY_MESSAGE = "Enter a quantity with up to 3 decimal places";
export const isWhole = (value: string | number) => Number.isInteger(Number(value));
// Subtract without floating-point noise (0.3 - 0.1 must stay 0.2).
export const subtractQuantity = (a: string | number, b: string | number) => String(Math.round((Number(a) - Number(b)) * 1000) / 1000);
