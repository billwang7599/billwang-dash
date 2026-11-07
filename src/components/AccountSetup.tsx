import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal.tsx";

interface Props {
    onSave: (name: { firstName: string; lastName: string }) => void;
}

/**
 * First-run step: asks for the name the sidebar greets you by. The login gives
 * none, so it's stored on the account. Can't be dismissed; it only shows while
 * no first name is saved.
 */
export function AccountSetup({ onSave }: Props) {
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const firstRef = useRef<HTMLInputElement>(null);

    useEffect(() => firstRef.current?.focus(), []);

    const canSave = firstName.trim() !== "" && lastName.trim() !== "";

    function save(e: React.FormEvent) {
        e.preventDefault();
        if (canSave) onSave({ firstName: firstName.trim(), lastName: lastName.trim() });
    }

    return (
        <Modal label="Welcome to dash" className="setup-modal">
            <form onSubmit={save}>
                <h2 className="setup-title">
                    Welcome to dash<span className="dot">.</span>
                </h2>
                <p className="setup-lede">What should we call you?</p>

                <div className="modal-grid">
                    <label>
                        <span>First name</span>
                        <input
                            ref={firstRef}
                            value={firstName}
                            maxLength={50}
                            autoComplete="given-name"
                            onChange={(e) => setFirstName(e.target.value)}
                        />
                    </label>
                    <label>
                        <span>Last name</span>
                        <input
                            value={lastName}
                            maxLength={50}
                            autoComplete="family-name"
                            onChange={(e) => setLastName(e.target.value)}
                        />
                    </label>
                </div>

                <p className="modal-note">You can change this later in Settings.</p>

                <div className="modal-actions">
                    <button type="submit" className="btn btn-primary" disabled={!canSave}>
                        Continue
                    </button>
                </div>
            </form>
        </Modal>
    );
}
