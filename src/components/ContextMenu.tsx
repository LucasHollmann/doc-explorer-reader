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

  const rows: ContextMenuItem[][] = [];
  for (const item of state.items) {
    const lastRow = rows[rows.length - 1];
    if (item.compact && lastRow?.every((i) => i.compact)) {
      lastRow.push(item);
    } else {
      rows.push([item]);
    }
  }

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
      <div className="context-menu" style={{ top: state.y, left: state.x }}>
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
