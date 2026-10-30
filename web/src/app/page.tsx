import Image from "next/image";
import Link from "next/link";

import styles from "./landing.module.css";

const GITHUB = "https://github.com/metadimensions/worldforge";

const STEPS = [
  {
    title: "Simulate",
    text: "A Python simulator drives a robot through a warehouse with shelves and a moving forklift. Every run ends as success, collision, timeout, no path or stuck.",
  },
  {
    title: "Ask Nemotron",
    text: "NVIDIA Nemotron reads the recorded results, explains why the robot failed, and proposes new scenarios that might break it again. Every claim points to a real run.",
  },
  {
    title: "Test and compare",
    text: "The simulator runs those scenarios. The same number of random scenarios run next to them, so you can see whether the AI actually found more failures.",
  },
];

const DEMO = [
  ["Success run", "The robot plans a route and reaches the goal."],
  ["Failure run", "A forklift crosses the aisle and hits the robot from the side. Playback stops at the moment of impact."],
  ["AI testing", "Open the AI tab on the failure run and start an experiment with Nemotron."],
];

export default function Home() {
  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <span className={styles.logo}>WorldForge</span>
        <nav className={styles.links}>
          <a href="#how">How it works</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
          <Link href="/demo?replay=success" className={styles.navCta}>Live demo</Link>
        </nav>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={styles.heroText}>
            <p className={styles.eyebrow}>Robot failure discovery</p>
            <h1>Find the situations where your robot fails.</h1>
            <p className={styles.lead}>
              WorldForge simulates a warehouse robot, asks an AI model which scenarios might break it, runs them and
              replays every run in 3D.
            </p>
            <div className={styles.ctas}>
              <Link href="/demo?replay=success" className={styles.primary}>Live demo</Link>
              <Link href="/demo?replay=failure" className={styles.secondary}>Watch the collision</Link>
            </div>
          </div>
          <figure className={styles.shot}>
            <Image
              src="/landing/collision.png"
              alt="3D replay of the robot being hit by a forklift at t = 4.35 s"
              width={940}
              height={600}
              priority
            />
            <figcaption>The baseline failure: a forklift hits the robot at 4.35 s.</figcaption>
          </figure>
        </section>

        <section id="how" className={styles.section}>
          <h2>How it works</h2>
          <ol className={styles.steps}>
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className={styles.num}>{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.section}>
          <h2>In the demo</h2>
          <div className={styles.demo}>
            <ul>
              {DEMO.map(([title, text]) => (
                <li key={title}>
                  <b>{title}</b>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
            <Link href="/demo?replay=success" className={styles.primary}>Start the demo</Link>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>WorldForge</span>
      </footer>
    </div>
  );
}
