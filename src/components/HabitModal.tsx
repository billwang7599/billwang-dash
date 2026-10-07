import { useEffect, useRef, useState } from "react";
import { habitInputSchema, type HabitFreq, type HabitInput, type HabitSummary } from "../../shared/habits.ts";
import { useDismiss } from "../useDismiss.ts";
import { Modal } from "./Modal.tsx";

interface Props {
    /** Present when editing. */
    habit?: HabitSummary;
    onSave: (input: HabitInput) => Promise<void>;
    onClose: () => void;
}

/** Monday first, like the calendar; values are Date weekdays (0 = Sunday). */
const DAYS: { value: number; label: string }[] = [
    { value: 1, label: "Mon" },
    { value: 2, label: "Tue" },
    { value: 3, label: "Wed" },
    { value: 4, label: "Thu" },
    { value: 5, label: "Fri" },
    { value: 6, label: "Sat" },
    { value: 0, label: "Sun" },
];

export function HabitModal({ habit, onSave, onClose }: Props) {
    const [closing, close] = useDismiss(onClose);
    const [name, setName] = useState(habit?.name ?? "");
    const [description, setDescription] = useState(habit?.description ?? "");
    const [freq, setFreq] = useState<HabitFreq>(habit?.freq ?? "daily");
    const [perWeek, setPerWeek] = useState(habit?.perWeek ?? 3);
    const [weekdays, setWeekdays] = useState<number[]>(habit?.weekdays ?? [1, 3, 5]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const nameRef = useRef<HTMLInputElement>(null);

    useEffect(() => nameRef.current?.focus(), []);

    const parsed = habitInputSchema.safeParse({
        name,
        description,
        freq,
        perWeek: freq === "weekly_count" ? perWeek : null,
        weekdays: freq === "weekdays" ? weekdays : [],
    });
    const canSave = parsed.success;

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

    const toggleDay = (value: number) =>
        setWeekdays((days) => (days.includes(value) ? days.filter((d) => d !== value) : [...days, value]));

    return (
        <Modal label={habit ? "Edit habit" : "New habit"} className="habit-modal" closing={closing} onClose={close}>
            <form onSubmit={save}>
                <input
                    ref={nameRef}
                    className="modal-title"
                    value={name}
                    maxLength={100}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Habit name, e.g. Meditate"
                    aria-label="Habit name"
                />

                <textarea
                    className="modal-desc"
                    value={description}
                    maxLength={1000}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Description (optional)"
                    aria-label="Description"
                    rows={2}
                />

                <div className="modal-grid">
                    <label className="modal-wide">
                        <span>How often</span>
                        <select value={freq} onChange={(e) => setFreq(e.target.value as HabitFreq)}>
                            <option value="daily">Every day</option>
                            <option value="weekly_count">A number of times a week</option>
                            <option value="weekdays">On specific days</option>
                        </select>
                    </label>

                    {freq === "weekly_count" && (
                        <label className="modal-wide">
                            <span>Times a week</span>
                            <select value={perWeek} onChange={(e) => setPerWeek(Number(e.target.value))}>
                                {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                                    <option key={n} value={n}>
                                        {n}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}

                    {freq === "weekdays" && (
                        <div className="modal-wide">
                            <span className="habit-days-label">Days</span>
                            <div className="habit-days" role="group" aria-label="Days of the week">
                                {DAYS.map(({ value, label }) => (
                                    <button
                                        key={value}
                                        type="button"
                                        className={`habit-day-btn${weekdays.includes(value) ? " is-on" : ""}`}
                                        aria-pressed={weekdays.includes(value)}
                                        onClick={() => toggleDay(value)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {habit && (
                    <p className="modal-note">
                        Changing how often applies to your whole history, so past streaks are recalculated.
                    </p>
                )}
                {error && <p className="modal-error">{error}</p>}

                <div className="modal-actions">
                    <button type="button" className="btn btn-quiet" onClick={close}>
                        Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={!canSave || busy}>
                        {busy ? "Saving…" : habit ? "Save" : "Add habit"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
