/**
 * Line endings for edited text. Agents send LF; edited text follows the line
 * endings of what it replaces. Deciding from "the file contains a CRLF
 * somewhere" broke files that mix both: one CRLF line turned every LF match
 * into CODE_NOT_FOUND and moved inserted code to the end of the file.
 */
export function dominantEol(text: string): "\r\n" | "\n" {
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length - crlf;
    return crlf > lf ? "\r\n" : "\n";
}

export function withEol(text: unknown, eol: string): string {
    return String(text).replace(/\r?\n/g, eol);
}
