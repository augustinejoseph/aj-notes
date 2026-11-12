"use client";
import { useEffect, useState, useRef } from "react";
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  filterSuggestionItems,
  type PartialBlock,
} from "@blocknote/core";
import {
  FilePanelController,
  UploadTab,
  useComponentsContext,
  useBlockNoteEditor,
  type FilePanelProps,
  createReactBlockSpec,
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { imageURL, putImage, importImage } from "@/lib/local";
import type { Block } from "@/lib/model";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
function MermaidPreview({ code }: { code: string }) {
  const [src, setSrc] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { default: mermaid } = await import("mermaid");
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            maxTextSize: 20000,
            suppressErrorRendering: true,
          });
          const { svg } = await mermaid.render(
            `diagram-${crypto.randomUUID()}`,
            code,
          );
          if (alive) {
            setSrc(
              URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })),
            );
            setError("");
          }
        } catch {
          if (alive) {
            setSrc("");
            setError("Diagram could not render. Check the Mermaid source.");
          }
        }
      })();
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code]);
  useEffect(
    () => () => {
      if (src) URL.revokeObjectURL(src);
    },
    [src],
  );
  // An image document cannot execute SVG scripts or navigate the parent app.
  return (
    <>
      {src && <img className="diagram" src={src} alt="Mermaid diagram" />}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
const mermaidBlock = createReactBlockSpec(
  {
    type: "mermaid",
    propSchema: { code: { default: "graph TD\n  Idea --> Note" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <div className="mermaid-block" contentEditable={false}>
        <label>
          Mermaid diagram
          <textarea
            aria-label="Mermaid source"
            value={block.props.code}
            readOnly={!editor.isEditable}
            onChange={(e) =>
              editor.updateBlock(block, { props: { code: e.target.value } })
            }
          />
        </label>
        <MermaidPreview code={block.props.code} />
      </div>
    ),
  },
);
const { audio: _, video: __, file: ___, ...coreBlocks } = defaultBlockSpecs;
const schema = BlockNoteSchema.create({
  blockSpecs: { ...coreBlocks, mermaid: mermaidBlock() },
});
function ImageEmbed({ blockId }: FilePanelProps) {
  const editor = useBlockNoteEditor<typeof schema.blockSchema>();
  const [url, setURL] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="image-embed"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          const path = await importImage(url);
          if (editor.getBlock(blockId))
            editor.updateBlock(blockId, { props: { url: path } });
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Image could not be embedded",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        aria-label="Image URL"
        placeholder="https://…"
        type="url"
        required
        value={url}
        disabled={busy}
        onChange={(e) => setURL(e.target.value)}
      />
      <button className="primary" disabled={busy} type="submit">
        {busy ? "Adding image…" : "Embed image"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function ImagePanel({ blockId }: FilePanelProps) {
  const Components = useComponentsContext()!;
  const [tab, setTab] = useState("Upload"),
    [loading, setLoading] = useState(false);
  return (
    <Components.FilePanel.Root
      className="bn-panel"
      defaultOpenTab="Upload"
      openTab={tab}
      setOpenTab={setTab}
      loading={loading}
      tabs={[
        {
          name: "Upload",
          tabPanel: <UploadTab blockId={blockId} setLoading={setLoading} />,
        },
        { name: "Embed", tabPanel: <ImageEmbed blockId={blockId} /> },
      ]}
    />
  );
}
export default function Editor({
  document,
  onChange,
  readOnly = false,
  onError,
}: {
  document: Block[];
  onChange: (document: Block[]) => void;
  readOnly?: boolean;
  onError: (message: string) => void;
}) {
  const callback = useRef(onChange);
  callback.current = onChange;
  const editor = useCreateBlockNote({
    schema,
    initialContent: document.length
      ? (document as PartialBlock<typeof schema.blockSchema>[])
      : undefined,
    uploadFile: async (file) => {
      try {
        return await putImage(file);
      } catch (e) {
        onError(String(e));
        throw e;
      }
    },
    resolveFileUrl: imageURL,
  });
  useEffect(
    () => editor.onChange(() => callback.current(editor.document as Block[])),
    [editor],
  );
  async function paste(event: React.ClipboardEvent) {
    const html = event.clipboardData.getData("text/html");
    if (!html.includes("<img")) return;
    event.preventDefault();
    event.stopPropagation();
    const clipboardImages = [...event.clipboardData.files].filter((file) =>
      file.type.startsWith("image/"),
    );
    try {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      for (const unsafe of parsed.querySelectorAll(
        "script,style,iframe,object,embed",
      ))
        unsafe.remove();
      for (const element of parsed.querySelectorAll("*"))
        for (const attr of [...element.attributes])
          if (
            attr.name.startsWith("on") ||
            ["srcdoc", "style"].includes(attr.name)
          )
            element.removeAttribute(attr.name);
      for (const image of parsed.querySelectorAll("img")) {
        const path = image.getAttribute("src") || "";
        try {
          const url = new URL(path, location.origin);
          if (
            url.origin === location.origin &&
            /^\/api\/images\/[a-f0-9-]{36}$/.test(url.pathname)
          ) {
            await imageURL(url.pathname);
            image.setAttribute("src", url.pathname);
            continue;
          }
          const clipboardImage = clipboardImages.shift();
          if (clipboardImage) {
            image.setAttribute("src", await putImage(clipboardImage));
            continue;
          }
          if (
            !/^https?:\/\//i.test(path) &&
            !(
              /^data:image\/(png|jpeg|webp|gif|avif);base64,/i.test(path) &&
              path.length < 14000000
            ) &&
            !path.startsWith(`blob:${location.origin}/`)
          )
            throw new Error("Image unavailable");
          if (/^https?:\/\//i.test(path)) {
            image.setAttribute("src", await importImage(path));
          } else {
            const response = await fetch(path, {
              signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) throw new Error("Image unavailable");
            image.setAttribute("src", await putImage(await response.blob()));
          }
        } catch {
          const placeholder = parsed.createElement("p");
          placeholder.textContent = `[Image could not be copied${image.alt ? `: ${image.alt}` : ""}. Use /image to upload the original image.]`;
          image.replaceWith(placeholder);
        }
      }
      const blocks = editor.tryParseHTMLToBlocks(parsed.body.innerHTML);
      // DOMParser resolves image.src to an absolute URL; persist portable attachment paths.
      function normalizeImages(items: Block[]) {
        for (const block of items) {
          if (block.type === "image" && typeof block.props?.url === "string") {
            const url = new URL(block.props.url, location.origin);
            if (
              url.origin === location.origin &&
              /^\/api\/images\/[a-f0-9-]{36}$/.test(url.pathname)
            )
              block.props.url = url.pathname;
          }
          if (block.children) normalizeImages(block.children);
        }
      }
      normalizeImages(blocks as Block[]);
      editor.insertBlocks(
        blocks,
        editor.getTextCursorPosition().block,
        "after",
      );
    } catch (e) {
      onError(
        e instanceof Error
          ? e.message
          : "Paste failed. Try pasting the text and uploading images separately.",
      );
    }
  }
  return (
    <div onPasteCapture={readOnly ? undefined : paste}>
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme="light"
        slashMenu={false}
        filePanel={false}
      >
        <FilePanelController filePanel={ImagePanel} />
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor),
                {
                  title: "Mermaid diagram",
                  subtext: "Diagram from editable text",
                  group: "Media",
                  aliases: ["diagram", "mermaid"],
                  onItemClick: () =>
                    editor.insertBlocks(
                      [{ type: "mermaid" }],
                      editor.getTextCursorPosition().block,
                      "after",
                    ),
                },
              ],
              query,
            )
          }
        />
      </BlockNoteView>
    </div>
  );
}
