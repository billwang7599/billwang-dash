import { describe, expect, it } from "vitest";
import { LANGUAGES, pickLanguage, translate, type Key, type Lang } from "../src/shareI18n.ts";

const KEYS: Key[] = [
    "sharedBy", "todo", "addPlaceholder", "addLabel", "add", "adding", "complete", "completed",
    "viaLink", "empty", "note", "limit", "deadTitle", "deadBody", "failed", "language",
];

describe("share page translations", () => {
    it("has every string in every language, with its holes intact", () => {
        for (const lang of Object.keys(LANGUAGES) as Lang[]) {
            for (const key of KEYS) {
                expect(translate(lang, key, { name: "N", task: "T" }), `${lang}.${key}`).not.toBe("");
            }
            expect(translate(lang, "sharedBy", { name: "Bill" }), lang).toContain("Bill");
            expect(translate(lang, "complete", { task: "Milk" }), lang).toContain("Milk");
            expect(translate(lang, "completed", { task: "Milk" }), lang).toContain("Milk");
        }
    });

    it("fills holes and leaves none behind", () => {
        expect(translate("en", "sharedBy", { name: "Bill" })).toBe("Shared by Bill");
        expect(translate("fr", "sharedBy")).not.toContain("{");
    });
});

describe("pickLanguage", () => {
    it("takes the first supported language in the browser's order", () => {
        expect(pickLanguage(["de-DE", "fr-CA", "en"])).toBe("fr");
        expect(pickLanguage(["es-MX"])).toBe("es");
        expect(pickLanguage(["ko-KR"])).toBe("ko");
    });

    it("splits Chinese into Simplified and Traditional", () => {
        expect(pickLanguage(["zh-CN"])).toBe("zh-Hans");
        expect(pickLanguage(["zh"])).toBe("zh-Hans");
        expect(pickLanguage(["zh-Hans-CN"])).toBe("zh-Hans");
        expect(pickLanguage(["zh-TW"])).toBe("zh-Hant");
        expect(pickLanguage(["zh-HK"])).toBe("zh-Hant");
        expect(pickLanguage(["zh-Hant"])).toBe("zh-Hant");
    });

    it("falls back to English", () => {
        expect(pickLanguage(["de", "ja"])).toBe("en");
        expect(pickLanguage([])).toBe("en");
    });
});
