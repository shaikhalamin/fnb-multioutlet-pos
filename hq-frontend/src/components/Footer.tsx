export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="site-footer mt-24 px-4 pb-14 pt-10">
      <div className="page-wrap flex flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
        <p className="m-0 text-body-sm text-body">
          &copy; {year} F&amp;B Platform — HQ Console. All rights reserved.
        </p>
        <p className="kicker m-0">Phase 0 · Foundation</p>
      </div>
    </footer>
  )
}
