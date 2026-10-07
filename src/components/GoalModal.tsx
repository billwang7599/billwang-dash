import { useEffect, useRef, useState } from "react";
import {
    goalInputSchema,
    horizonMismatch,
    isDone,
    HORIZON_HINTS,
    HORIZON_LABELS,
    HORIZONS,
    type Goal,
    type GoalInput,
    type Horizon,
} from "../../shared/goals.ts";
import { useDismiss } from "../useDismiss.ts";
import { Modal } from "./Modal.tsx";

interface Props {
    /** Present when editing. */
    goal?: Goal;
    /** Preselected horizon for a new goal, e.g. from that section's "+ Add". */
    horizon?: Horizon;
    /** Today in the user's zone, YYYY-MM-DD. */
    today: string;
    onSave: (input: GoalInput) => Promise<void>;
    /** Editing only: hands over to the delete confirmation. */
    onDelete?: () => void;
    onClose: () => void;
}

/** Number fields stay strings while typing; junk becomes NaN, which the schema rejects. */
const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

/**
 * Plain text fields, not type="number": Safari lets letters into those and then
 * shows its own unstyled popup. Dropping anything but digits and a point keeps
 * the field clean; a stray second point is left for the schema to reject.
 */
export const numeric = (s: string) => s.replace(/[^\d.]/g, "");

export function GoalModal({ goal, horizon: initialHorizon, today, onSave, onDelete, onClose }: Props) {
    const [closing, close] = useDismiss(onClose);
    const [title, setTitle] = useState(goal?.title ?? "");
    const [why, setWhy] = useState(goal?.why ?? "");
    const [horizon, setHorizon] = useState<Horizon>(goal?.horizon ?? initialHorizon ?? "short");
    const [target, setTarget] = useState(goal?.target != null ? String(goal.target) : "");
    const [current, setCurrent] = useState(goal ? String(goal.current) : "0");
    const [unit, setUnit] = useState(goal?.unit ?? "");
    const [deadline, setDeadline] = useState(goal?.deadline ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const titleRef = useRef<HTMLInputElement>(null);

    useEffect(() => titleRef.current?.focus(), []);

    // A blank target makes a yes/no goal, which keeps whether it was done.
    const yesNo = target.trim() === "";
    const parsed = goalInputSchema.safeParse({
        title,
        why,
        horizon,
        target: yesNo ? null : num(target),
        current: yesNo ? (goal && isDone(goal) ? 1 : 0) : num(current),
        unit: yesNo ? "" : unit,
        deadline,
    });
    const canSave = parsed.success;
    // Say what's stopping a save rather than leaving the button silently dead.
    const missing = [
        !title.trim() && "a goal",
        !yesNo && !(num(target) > 0) && "a target above 0 (or leave it blank)",
        !yesNo && !(num(current) >= 0) && "progress as a number",
        !deadline && "a deadline",
    ].filter(Boolean);
    const mismatch = deadline ? horizonMismatch(horizon, today, deadline) : null;

    async function save(event: React.FormEvent) {
        event.preventDefault();
        if (!parsed.success) return;
        setBusy(true);
        setError(null);
        try {
            await onSave(parsed.data);
            close();
        } catch (err) {
            setError((err as Error).message);
            setBusy(false);
        }
    }

    return (
        <Modal label={goal ? "Edit goal" : "New goal"} className="goal-modal" closing={closing} onClose={close}>
            <form onSubmit={save} noValidate>
                <input
                    ref={titleRef}
                    className="modal-title"
                    value={title}
                    maxLength={100}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Something specific, e.g. Read 12 books"
                    aria-label="Goal"
                />

                <textarea
                    className="modal-desc"
                    value={why}
                    maxLength={1000}
                    onChange={(e) => setWhy(e.target.value)}
                    placeholder="Why it matters to you (optional)"
                    aria-label="Why it matters"
                    rows={2}
                />

                <div className="modal-grid">
                    <div className="modal-wide">
                        <span className="goal-field-label">Horizon</span>
                        <div className="goal-horizons" role="group" aria-label="Horizon">
                            {HORIZONS.map((h) => (
                                <button
                                    key={h}
                                    type="button"
                                    className={`habit-day-btn${horizon === h ? " is-on" : ""}`}
                                    aria-pressed={horizon === h}
                                    title={HORIZON_HINTS[h]}
                                    onClick={() => setHorizon(h)}
                                >
                                    {HORIZON_LABELS[h]}
                                </button>
                            ))}
                        </div>
                    </div>

                    <label>
                        <span>Target</span>
                        <input
                            inputMode="decimal"
                            value={target}
                            onChange={(e) => setTarget(numeric(e.target.value))}
                            placeholder="blank = yes/no"
                        />
                    </label>

                    <label>
                        <span>Unit</span>
                        <input
                            value={unit}
                            maxLength={30}
                            disabled={yesNo}
                            onChange={(e) => setUnit(e.target.value)}
                            placeholder="optional, e.g. books"
                        />
                    </label>

                    <label>
                        <span>Progress so far</span>
                        <input
                            inputMode="decimal"
                            value={yesNo ? "" : current}
                            disabled={yesNo}
                            onChange={(e) => setCurrent(numeric(e.target.value))}
                        />
                    </label>

                    <label>
                        <span>Deadline</span>
                        <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
                    </label>
                </div>

                {mismatch && <p className="modal-note goal-mismatch">{mismatch}</p>}
                {!canSave && missing.length > 0 && <p className="modal-note">Still needs {missing.join(", ")}.</p>}
                {error && <p className="modal-error">{error}</p>}

                <div className="modal-actions">
                    {goal && onDelete && (
                        <button type="button" className="btn btn-quiet btn-quiet-danger modal-delete" onClick={onDelete}>
                            Delete
                        </button>
                    )}
                    <button type="button" className="btn btn-quiet" onClick={close}>
                        Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={!canSave || busy}>
                        {busy ? "Saving…" : goal ? "Save" : "Add goal"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
