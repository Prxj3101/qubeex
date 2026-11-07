import express from "express";
import request from "supertest";
import { errorHandler } from "../../middlewares/errorHandler.middleware";
import { isbnRouter } from "./isbn.routes";

const app = express();
app.use("/isbn", isbnRouter); app.use(errorHandler);
const fetchMock = jest.fn();
beforeEach(() => { jest.clearAllMocks(); global.fetch = fetchMock as unknown as typeof fetch; });

test("maps Open Library data to title, author and cover", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ "ISBN:9780140328721": {
    title: "Fantastic Mr Fox", authors: [{ name: "Roald Dahl" }, { name: "Quentin Blake" }], cover: { medium: "https://covers.openlibrary.org/b/id/1-M.jpg" },
  } }) });
  const res = await request(app).get("/isbn/9780140328721");
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ title: "Fantastic Mr Fox", author: "Roald Dahl, Quentin Blake", coverUrl: "https://covers.openlibrary.org/b/id/1-M.jpg" });
});

test("hyphens and spaces in the ISBN are ignored", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
  await request(app).get("/isbn/978-0-14-032872-1");
  expect(fetchMock.mock.calls[0][0]).toContain("ISBN:9780140328721");
});

test("an unknown ISBN returns empty data, not an error", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
  const res = await request(app).get("/isbn/9780140328721");
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({});
});

test("a network failure returns empty data so the librarian can type it", async () => {
  fetchMock.mockRejectedValue(new Error("timeout"));
  const res = await request(app).get("/isbn/9780140328721");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, data: {} });
});

test("a malformed ISBN is rejected without calling out", async () => {
  expect((await request(app).get("/isbn/abc")).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});
