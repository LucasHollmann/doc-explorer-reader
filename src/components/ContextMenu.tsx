import "./ContextMenu.css";

export type ContextMenuItem = {
  label: string;
  onClick: () => void;
  danger?: boolean;
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
        {state.items.map((item, index) => (
          <button
            key={index}
            className={item.danger ? "danger" : ""}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

export default ContextMenu;
