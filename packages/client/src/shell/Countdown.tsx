import { useEffect, useState } from "react";

/** Whole seconds left until `deadline` (a `Date.now()` time), counting down while shown. */
export function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <span role="timer" className="countdown">
      {Math.max(0, Math.ceil((deadline - now) / 1000))}s left
    </span>
  );
}
