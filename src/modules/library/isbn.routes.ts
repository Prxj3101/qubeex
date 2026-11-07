import { Router, Response, NextFunction } from "express";
import { BadRequestError } from "../../utils/errors";

type OpenLibraryBook = { title?: string; authors?: { name?: string }[]; cover?: { medium?: string; large?: string } };

const LOOKUP_TIMEOUT_MS = 4000;

export const isbnRouter = Router();

isbnRouter.get("/:isbn", async (req, res: Response, next: NextFunction) => {
  try {
    const isbn = String(req.params.isbn).replace(/[-\s]/g, "");
    if (!/^(\d{9}[\dXx]|\d{13})$/.test(isbn)) throw new BadRequestError("Enter a valid 10 or 13 digit ISBN");
    try {
      const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
      const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      if (!response.ok) return res.json({ success: true, data: {} });
      const body = (await response.json()) as Record<string, OpenLibraryBook>;
      const book = body[`ISBN:${isbn}`];
      if (!book) return res.json({ success: true, data: {} });
      const author = book.authors?.map((a) => a.name).filter(Boolean).join(", ");
      return res.json({ success: true, data: {
        ...(book.title ? { title: book.title } : {}),
        ...(author ? { author } : {}),
        ...(book.cover?.medium ?? book.cover?.large ? { coverUrl: book.cover?.medium ?? book.cover?.large } : {}),
      } });
    } catch {
      // Lookup is a convenience; the librarian can always type the details.
      return res.json({ success: true, data: {} });
    }
  } catch (err) { next(err); }
});
