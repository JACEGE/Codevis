import { useMemo, useState, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

import BRIDGE_URL from '../bridgeUrl';

function slugify(text) {
    return text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

function addHeadingIds(html) {
    return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_match, level, inner) => {
        const text = inner.replace(/<[^>]+>/g, '');
        return `<h${level} id="${slugify(text)}">${inner}</h${level}>`;
    });
}

function resolveDocumentationPath(currentPath, linkedPath) {
    const base = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
    const parts = `${base}${linkedPath}`.split('/');
    const resolved = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') resolved.pop();
        else resolved.push(part);
    }
    return resolved.join('/');
}

function renderMarkdown(markdown, currentPath = 'README.md') {
    const html = addHeadingIds(marked.parse(markdown, {
        gfm: true,
        breaks: false,
        walkTokens(token) {
            if (token.type === 'link' && /^(?:\.\.?\/)*(?:[^/?#]+\/)*[^/?#]+\.md(?:#.*)?$/.test(token.href)) {
                const [linkedPath, anchor = ''] = token.href.split('#', 2);
                const documentPath = resolveDocumentationPath(currentPath, linkedPath);
                token.href = `#doc=${encodeURIComponent(documentPath)}${anchor ? `&anchor=${encodeURIComponent(anchor)}` : ''}`;
            }
        },
    }));
    return DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'option'],
    });
}

// The README is useful product documentation, but rendering all 650 lines at
// once makes the Docs tab a scroll wall. Preserve its introduction, then turn
// each level-two chapter into a native disclosure section. Markdown inside a
// chapter remains unchanged, including its smaller headings and code blocks.
function splitDocumentation(markdown, currentPath = 'README.md') {
    const parts = markdown.split(/(?=^##\s+)/m);
    const introduction = parts.shift() || '';
    const sections = parts.map((part) => {
        const firstLineEnd = part.indexOf('\n');
        const heading = part.slice(3, firstLineEnd < 0 ? undefined : firstLineEnd).trim();
        const body = firstLineEnd < 0 ? '' : part.slice(firstLineEnd + 1);
        return {
            id: slugify(heading.replace(/[`*_]/g, '')),
            heading,
            html: renderMarkdown(body, currentPath),
        };
    });
    return {
        introduction: renderMarkdown(introduction, currentPath),
        sections,
    };
}

export default function DocumentationPanel() {
    const [documentPath, setDocumentPath] = useState('README.md');
    const [markdown, setMarkdown] = useState('');
    const [error, setError] = useState(null);
    const [pendingAnchor, setPendingAnchor] = useState('');
    const docs = useMemo(() => splitDocumentation(markdown, documentPath), [markdown, documentPath]);

    useEffect(() => {
        let alive = true;
        setError(null);
        fetch(`${BRIDGE_URL}/api/docs?file=${encodeURIComponent(documentPath)}`)
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.text();
            })
            .then((value) => { if (alive) setMarkdown(value); })
            .catch((reason) => { if (alive) setError(reason.message); });
        return () => { alive = false; };
    }, [documentPath]);

    useEffect(() => {
        if (!pendingAnchor || !markdown) return;
        const target = globalThis.document.getElementById(pendingAnchor);
        if (!target) return;
        const disclosure = target.closest('details');
        if (disclosure) disclosure.open = true;
        requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        setPendingAnchor('');
    }, [markdown, pendingAnchor]);

    const followAnchor = (event) => {
        const documentLink = event.target.closest?.('a[href^="#doc="]');
        if (documentLink) {
            event.preventDefault();
            const params = new URLSearchParams(documentLink.getAttribute('href').slice(1));
            setPendingAnchor(params.get('anchor') || 'documentation-introduction');
            setDocumentPath(params.get('doc') || 'README.md');
            return;
        }
        const anchor = event.target.closest?.('a[href^="#"]');
        if (!anchor) return;
        event.preventDefault();
        const target = globalThis.document.getElementById(decodeURIComponent(anchor.getAttribute('href').slice(1)));
        if (!target) return;
        const disclosure = target.closest('details');
        if (disclosure) disclosure.open = true;
        requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    };

    return (
        <div className="codevis-docs-shell" onClick={followAnchor}>
            {error ? (
                <div className="codevis-docs-error">Could not load {BRIDGE_URL}/api/docs — {error}</div>
            ) : (
                <div className="codevis-docs">
                    <header className="codevis-docs-header">
                        <h1>CodeVis Documentation</h1>
                        <p>
                            {documentPath !== 'README.md' && <><button type="button" onClick={() => setDocumentPath('README.md')}>README</button>{' '}</>}
                            Choose a chapter. Only the section you need is expanded.
                        </p>
                    </header>
                    <div className="codevis-docs-index" aria-label="Documentation chapters">
                        <a href="#documentation-introduction">Introduction</a>
                        {docs.sections.map((section) => (
                            <a href={`#${section.id}`} key={section.id}>{section.heading}</a>
                        ))}
                    </div>
                    <div className="codevis-docs-sections">
                        <details className="codevis-docs-section">
                            <summary id="documentation-introduction">Introduction</summary>
                            <div
                                className="codevis-docs-section-body"
                                dangerouslySetInnerHTML={{ __html: docs.introduction }}
                            />
                        </details>
                        {docs.sections.map((section) => (
                            <details className="codevis-docs-section" key={section.id}>
                                <summary id={section.id}>{section.heading}</summary>
                                <div
                                    className="codevis-docs-section-body"
                                    dangerouslySetInnerHTML={{ __html: section.html }}
                                />
                            </details>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
