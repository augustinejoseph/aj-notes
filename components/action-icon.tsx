export function ActionIcon({ name }: { name: "settings" | "logout" | "sync" }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "settings" ? (
        <>
          <path d="m9 3-.6 2.1-1.8 1L4.5 6l-2 3.5 1.5 1.6v1.8L2.5 14.5l2 3.5 2.1-.1 1.8 1L9 21h4l.6-2.1 1.8-1 2.1.1 2-3.5-1.5-1.6v-1.8l1.5-1.6-2-3.5-2.1.1-1.8-1L13 3Z" />
          <circle cx="11" cy="12" r="3" />
        </>
      ) : name === "logout" ? (
        <>
          <path d="M10 17v3H4V4h6v3M9 12h12m-4-4 4 4-4 4" />
        </>
      ) : (
        <>
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17" />
        </>
      )}
    </svg>
  );
}
