import React, { useEffect } from "react";

const ModalDialog = ({ title, open, onClose, children }) => {
  useEffect(() => {
    if (!open) return undefined;
    const onEsc = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ss-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="ss-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="ss-modal-title">{title}</h2>
        <div className="ss-modal-content">{children}</div>
        <button type="button" className="ss-btn ss-btn-primary" onClick={onClose}>
          Close
        </button>
      </section>
    </div>
  );
};

export default ModalDialog;

