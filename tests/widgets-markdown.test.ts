import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "../src/widgets/markdown.js";

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<b>a & "b" 'c'</b>`)).toBe("&lt;b&gt;a &amp; &quot;b&quot; &#39;c&#39;&lt;/b&gt;");
  });
});

describe("renderMarkdown — the tiny safe subset", () => {
  it("renders headings, bold, italic and inline code", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and *italic* and `code`.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders bullet and ordered lists", () => {
    const html = renderMarkdown("- one\n- two\n\n1. first\n2. second");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("renders task list items as checkboxes, checked and unchecked", () => {
    const html = renderMarkdown("- [x] done\n- [ ] not done");
    expect(html).toContain('<input type="checkbox" disabled checked/>');
    expect(html).toContain('<input type="checkbox" disabled />');
    expect(html).toContain("done");
    expect(html).toContain("not done");
  });

  it("renders a safe link with http/https/mailto", () => {
    expect(renderMarkdown("[go](https://example.edu/a)")).toBe(
      '<p><a href="https://example.edu/a" target="_blank" rel="noopener noreferrer">go</a></p>',
    );
    expect(renderMarkdown("[mail](mailto:a@b.edu)")).toContain('href="mailto:a@b.edu"');
    expect(renderMarkdown("[rel](/settings)")).toContain('href="/settings"');
  });

  it("drops the href for an unsafe URL scheme but keeps the label as text", () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
  });

  it("never renders a raw HTML tag from the source — it is escaped, not parsed", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    // The attacker's text survives (that's fine — it's inert), but as an
    // escaped &lt;img ...&gt;, never as a real element the DOM would parse
    // and fire onerror on.
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<img\s/);
    expect(html).toBe('<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
  });

  it("escapes an XSS attempt hidden inside a link label", () => {
    const html = renderMarkdown('[<script>alert(1)</script>](https://example.edu)');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a data: URL attempt the same way as javascript:", () => {
    const html = renderMarkdown("[open](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("data:text/html");
  });

  it("does not evaluate bold/italic markers found inside inline code", () => {
    const html = renderMarkdown("`**not bold**`");
    expect(html).toBe("<p><code>**not bold**</code></p>");
  });
});
