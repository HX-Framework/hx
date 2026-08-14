import { OctocatIc } from "../icons";

export function FooterBand() {
  return (
    <footer>
      <div className="inner">
        <div className="mark" style={{ marginTop: 5 }}><i></i><i></i><i></i><i></i></div>
        <div className="txt">
          <b>HX Client runs locally, as part of <code className="hx">hx</code>.</b><br />
          This page is served from this machine and never sends your data anywhere.
        </div>
        <div className="oss">
          <div className="osslbl">Open source</div>
          <a href="https://github.com/hx-framework/hx" target="_blank" rel="noreferrer"><OctocatIc /> github.com/hx-framework/hx</a>
        </div>
      </div>
    </footer>
  );
}
