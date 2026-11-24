import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import "./ContextMenu.css";

export type ContextMenuItem = {
  label: string;
  onClick: () => void;
  danger?: boolean;
  swatch?: string;
  compact?: boolean;
};

export type ContextMenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
};

type Props = {
  state: ContextMenuState | null;
  onClose: () => void;
};

function ContextMenu({ state, onClose }: Props) {
  if (!state) return null;
  return <ContextMenuPanel key={`${state.x}-${state.y}`} state={state} onClose={onClose} />;
}

function ContextMenuPanel({
  state,
  onClose,
}: {
  state: ContextMenuState;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 4;
    let top = state.y;
    let left = state.x;
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, state.y - rect.height);
    }
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, state.x - rect.width);
    }
    setPosition({ top, left });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows: ContextMenuItem[][] = [];
  for (const item of state.items) {
    const lastRow = rows[rows.length - 1];
    if (item.compact && lastRow?.every((i) => i.compact)) {
      lastRow.push(item);
    } else {
      rows.push([item]);
    }
  }

  const style: CSSProperties = position
    ? { top: position.top, left: position.left }
    : { top: state.y, left: state.x, visibility: "hidden" };

  return (
    <>
      <div
        className="context-menu-overlay"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="context-menu" ref={menuRef} style={style}>
        {rows.map((row, index) =>
          row[0].compact ? (
            <div className="context-menu-row" key={index}>
              {row.map((item, itemIndex) => (
                <button
                  key={itemIndex}
                  className="context-menu-swatch-btn"
                  title={item.label}
                  aria-label={item.label}
                  style={{ backgroundColor: item.swatch }}
                  onClick={() => {
                    item.onClick();
                    onClose();
                  }}
                />
              ))}
            </div>
          ) : (
            <button
              key={index}
              className={row[0].danger ? "danger" : ""}
              onClick={() => {
                row[0].onClick();
                onClose();
              }}
            >
              {row[0].swatch && (
                <span className="context-menu-swatch" style={{ backgroundColor: row[0].swatch }} />
              )}
              {row[0].label}
            </button>
          ),
        )}
      </div>
    </>
  );
}

export default ContextMenu;
