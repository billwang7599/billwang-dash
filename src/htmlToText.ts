/**
 * Google descriptions can contain HTML (Meet invites do). Show the text, keeping line
 * breaks. DOMParser builds an inert document, so nothing in it runs or loads.
 */
export function htmlToText(html: string): string {
    const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n");
    const text = new DOMParser().parseFromString(withBreaks, "text/html").body.textContent ?? "";
    return text.replace(/\n{3,}/g, "\n\n").trim();
}
