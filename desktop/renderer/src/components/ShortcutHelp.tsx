import { Dialog } from "../Dialog";

export interface ShortcutHelpProps {
  onClose: () => void;
}

export function ShortcutHelp({ onClose }: ShortcutHelpProps) {
  const shortcuts = [
    { key: "Ctrl + Shift + O", desc: "New chat" },
    { key: "Ctrl + N", desc: "New chat, including from the chat composer" },
    { key: "Enter", desc: "Send the chat message" },
    { key: "Shift + Enter", desc: "Add a line in the chat composer" },
    { key: "Ctrl + K", desc: "Open command palette" },
    { key: "Ctrl + Enter", desc: "Submit a Hive Code run" },
    { key: "Ctrl + 1", desc: "Switch to Conversation tab" },
    { key: "Ctrl + 2", desc: "Switch to Changes tab" },
    { key: "Ctrl + 3", desc: "Switch to Report tab" },
    { key: "? (Shift + /)", desc: "Show keyboard shortcuts" },
    { key: "Escape", desc: "Close dialog or command palette" },
  ];

  return (
    <Dialog title="Keyboard Shortcuts" onClose={onClose}>
      <table className="shortcut-table">
        <tbody>
          {shortcuts.map(({ key, desc }) => (
            <tr key={key}>
              <td>
                <kbd>{key}</kbd>
              </td>
              <td>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dialog-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}
