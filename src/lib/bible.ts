import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const JSON_DIR = path.join(DATA_DIR, "json");

export interface BookMeta {
  order: number;
  id: string;
  usfm_id: string;
  ks_book_id: number;
  abbr: string;
  title: string;
  name_en: string;
  testament: "SZ" | "NZ";
  category: string;
  deuterocanonical: boolean;
  deuterocanonical_parts?: string;
  chapter_count: number;
  verse_count: number;
}

export interface VerseHeading {
  level: "h2" | "h3" | "h4";
  text: string;
}

export interface VerseItem {
  verse: number;
  verse_label?: string;
  text: string;
  p?: boolean;
  headings?: VerseHeading[];
  references?: string[];
  lines?: string[];
}

export interface ChapterData {
  chapter: number;
  verse_count: number;
  verses: VerseItem[];
}

export interface BookPayload extends BookMeta {
  chapters: ChapterData[];
}

let cachedBooksMeta: BookMeta[] | null = null;
const cachedBookPayloads = new Map<number, BookPayload>();

export function getAllBooks(): BookMeta[] {
  if (!cachedBooksMeta) {
    const raw = fs.readFileSync(path.join(JSON_DIR, "books.json"), "utf-8");
    cachedBooksMeta = JSON.parse(raw) as BookMeta[];
  }
  return cachedBooksMeta;
}

export function getBookPayload(order: number): BookPayload {
  const existing = cachedBookPayloads.get(order);
  if (existing) return existing;
  const books = getAllBooks();
  const meta = books.find((b) => b.order === order);
  if (!meta) throw new Error(`Book order ${order} not found`);
  const padOrder = String(order).padStart(2, "0");
  const filePath = path.join(JSON_DIR, "books", `${padOrder}_${meta.id}.json`);
  const payload = JSON.parse(fs.readFileSync(filePath, "utf-8")) as BookPayload;
  cachedBookPayloads.set(order, payload);
  return payload;
}

export function getPlansIndex() {
  return JSON.parse(fs.readFileSync(path.join(JSON_DIR, "plans", "index.json"), "utf-8"));
}

export function getAuditReport() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "audit_report.json"), "utf-8"));
}
