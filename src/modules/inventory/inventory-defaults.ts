import { academicDb } from "../../utils/academicContext";

// Built-in setup records every school starts with. They can be renamed but never deleted.
export const DEFAULT_UNITS: { name: string; abbreviation: string }[] = [
  { name: "Pieces", abbreviation: "pcs" }, { name: "Box", abbreviation: "box" }, { name: "Packet", abbreviation: "pkt" },
  { name: "Set", abbreviation: "set" }, { name: "Pair", abbreviation: "pair" }, { name: "Dozen", abbreviation: "doz" },
  { name: "Ream", abbreviation: "ream" }, { name: "Bundle", abbreviation: "bndl" }, { name: "Roll", abbreviation: "roll" },
  { name: "Bottle", abbreviation: "btl" }, { name: "Can", abbreviation: "can" }, { name: "Litre", abbreviation: "L" },
  { name: "Millilitre", abbreviation: "ml" }, { name: "Kilogram", abbreviation: "kg" }, { name: "Gram", abbreviation: "g" },
  { name: "Metre", abbreviation: "m" }, { name: "Foot", abbreviation: "ft" }, { name: "Sheet", abbreviation: "sht" },
  { name: "Book", abbreviation: "book" }, { name: "Unit", abbreviation: "unit" },
];
export const DEFAULT_CATEGORIES: string[] = [
  "Stationery", "Furniture", "Electronics", "Computers & IT", "Sports", "Cleaning supplies", "Lab equipment", "Books & library",
  "Uniforms", "Art & craft", "Tools & hardware", "Medical & first aid", "Kitchen & canteen", "Electrical", "Printing & paper", "Miscellaneous",
];
export const DEFAULT_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  "Stationery": "Pens, pencils, erasers, rulers, staplers and writing supplies.",
  "Furniture": "Desks, chairs, benches, tables and cupboards.",
  "Electronics": "Projectors, speakers, cameras and electronic equipment.",
  "Computers & IT": "Computers, laptops, keyboards, mice and networking devices.",
  "Sports": "Bats, balls, rackets, nets and sports equipment.",
  "Cleaning supplies": "Mops, brooms, buckets, detergents and cleaners.",
  "Lab equipment": "Microscopes, glassware, instruments and lab supplies.",
  "Books & library": "Textbooks, reference books, storybooks and library supplies.",
  "Uniforms": "School uniforms, ties, belts and accessories.",
  "Art & craft": "Paints, brushes, colours, craft paper and supplies.",
  "Tools & hardware": "Hand tools, fasteners and maintenance supplies.",
  "Medical & first aid": "First-aid kits, bandages and medical supplies.",
  "Kitchen & canteen": "Utensils, cookware, trays and canteen equipment.",
  "Electrical": "Bulbs, switches, plugs, cables and electrical items.",
  "Printing & paper": "Printing paper, ink, toner and supplies.",
  "Miscellaneous": "Other school items outside the listed categories."
};
const PREVIOUS_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  "stationery": "Pens, pencils, erasers, rulers, staplers and everyday writing supplies.",
  "furniture": "Desks, chairs, benches, tables, cupboards and storage furniture.",
  "electronics": "Projectors, speakers, cameras and other electronic equipment.",
  "computers & it": "Computers, laptops, keyboards, mice and networking equipment.",
  "sports": "Bats, balls, rackets, nets and equipment for sports and games.",
  "cleaning supplies": "Mops, brooms, buckets, detergents and cleaning materials.",
  "lab equipment": "Microscopes, glassware, instruments and supplies for practical lessons.",
  "books & library": "Textbooks, reference books, storybooks and library materials.",
  "uniforms": "School uniforms, ties, belts and other uniform accessories.",
  "art & craft": "Paints, brushes, colours, craft paper and creative supplies.",
  "tools & hardware": "Hand tools, fasteners and supplies for repairs and maintenance.",
  "medical & first aid": "First-aid kits, bandages and basic medical supplies.",
  "kitchen & canteen": "Utensils, cookware, serving trays and canteen equipment.",
  "electrical": "Bulbs, switches, plugs, cables and electrical supplies.",
  "printing & paper": "Printing paper, ink, toner and printing supplies.",
  "miscellaneous": "Other school items that do not fit the listed categories."
};
export const DEFAULT_LOCATIONS: string[] = [
  "Store room", "Principal office", "Staff room", "Library", "Computer lab", "Science lab", "Sports room", "Reception", "Classroom block", "Canteen",
];

const key = (name: string) => name.toLowerCase();

/**
 * Creates the built-in records the first time a school opens its inventory setup.
 * A record the school already made with the same name is simply marked as built-in, so nothing is duplicated.
 * It only runs while the school has no built-in record of that kind, so a renamed built-in is never re-created.
 * Failures are ignored on purpose (for example a read-only archived year): the list is still returned.
 */
export async function ensureDefaultSetup(kind: "units" | "categories" | "locations", institutionId: string) {
  try {
    const db = academicDb();
    if (kind === "units") {
      if (await db.inventoryUnit.count({ where: { institutionId, isDefault: true } })) return;
      await db.inventoryUnit.createMany({ data: DEFAULT_UNITS.map(u => ({ institutionId, name: u.name, nameKey: key(u.name), abbreviation: u.abbreviation, isDefault: true })), skipDuplicates: true });
      await db.inventoryUnit.updateMany({ where: { institutionId, nameKey: { in: DEFAULT_UNITS.map(u => key(u.name)) } }, data: { isDefault: true } });
    } else if (kind === "categories") {
      if (!(await db.inventoryCategory.count({ where: { institutionId, isDefault: true } }))) {
        await db.inventoryCategory.createMany({ data: DEFAULT_CATEGORIES.map(name => ({ institutionId, name, nameKey: key(name), description: DEFAULT_CATEGORY_DESCRIPTIONS[name], isDefault: true })), skipDuplicates: true });
        await db.inventoryCategory.updateMany({ where: { institutionId, nameKey: { in: DEFAULT_CATEGORIES.map(key) } }, data: { isDefault: true } });
      }
      // Fill blanks and upgrade our previous descriptions, preserving school-written text.
      const blank = await db.inventoryCategory.findMany({ where: { institutionId, isDefault: true, OR: [{ description: "" }, ...Object.entries(PREVIOUS_CATEGORY_DESCRIPTIONS).map(([nameKey, description]) => ({ nameKey, description }))] }, select: { id: true, nameKey: true, description: true } });
      const descriptionsByKey = Object.fromEntries(Object.entries(DEFAULT_CATEGORY_DESCRIPTIONS).map(([name, description]) => [key(name), description]));
      for (const category of blank) {
        const description = descriptionsByKey[category.nameKey];
        if (description) await db.inventoryCategory.updateMany({ where: { id: category.id, institutionId, description: category.description }, data: { description } });
      }
    } else {
      if (await db.inventoryLocation.count({ where: { institutionId, isDefault: true } })) return;
      await db.inventoryLocation.createMany({ data: DEFAULT_LOCATIONS.map(name => ({ institutionId, name, nameKey: key(name), isDefault: true })), skipDuplicates: true });
      await db.inventoryLocation.updateMany({ where: { institutionId, nameKey: { in: DEFAULT_LOCATIONS.map(key) } }, data: { isDefault: true } });
    }
  } catch { /* setup lists still load without the built-in records */ }
}
