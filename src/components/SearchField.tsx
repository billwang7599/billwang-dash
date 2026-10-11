import { SearchIcon } from "./SearchIcons.tsx";

/** The pill search box on page view bars: a magnifier, and a clear button (or Esc) once there's a query. */
export function SearchField({
    value,
    onChange,
    placeholder,
    label,
}: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    label: string;
}) {
    return (
        <div className="search-field">
            <SearchIcon />
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && value && onChange("")}
                placeholder={placeholder}
                aria-label={label}
            />
            {value && (
                <button className="search-clear" onClick={() => onChange("")} aria-label="Clear search">
                    ×
                </button>
            )}
        </div>
    );
}
