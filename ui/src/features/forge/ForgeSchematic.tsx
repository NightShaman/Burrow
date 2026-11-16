/** Decorative workshop etching; the central opening keeps the crest unobstructed. */
export function ForgeSchematic({ enabled }: { enabled: boolean }) {
  return (
    <svg
      className={`forge-schematic${enabled ? ' forge-schematic-live' : ''}`}
      viewBox="0 0 2400 1000"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="forge-etch-mask">
          <stop offset="0" stopColor="black" />
          <stop offset=".29" stopColor="black" />
          <stop offset=".48" stopColor="white" />
          <stop offset=".87" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </radialGradient>
        <mask id="forge-etch-opening">
          <rect width="2400" height="1000" fill="url(#forge-etch-mask)" />
        </mask>
      </defs>
      <g mask="url(#forge-etch-opening)" fill="none" stroke="currentColor">
        <g className="forge-etch-lines">
          <path d="M0 240H310L390 320H680L810 450H1080 M0 265H298L378 345H660L790 475H1080 M80 760H400L510 650H710L850 510 M2400 310H2060L1980 390H1770L1630 530H1350 M2400 335H2070L1990 415H1790L1650 555H1350 M2400 790H2130L2020 680H1810L1690 560 M210 0V150L480 420V590L310 760V1000 M2180 0V190L1950 420V650L2210 910V1000" />
          <path d="M130 460H390L450 520H760 M110 485H370L430 545H740 M2350 610H2080L2000 530H1760 M2300 635H2060L1980 555H1780 M500 130H790L880 220H1030 M1550 800H1760L1850 890H2160" />
          {[
            { x: 510, y: 490, r: 245 },
            { x: 1930, y: 540, r: 290 },
            { x: 790, y: 850, r: 170 },
          ].map(({ x, y, r }) => (
            <g key={x}>
              <circle cx={x} cy={y} r={r} strokeDasharray="160 40 70 120" />
              <circle cx={x} cy={y} r={r - 16} strokeDasharray="2 16" strokeWidth="7" />
              <circle cx={x} cy={y} r={r + 30} strokeDasharray="85 290 210 90" />
              {Array.from({ length: 12 }, (_, i) => (
                <path
                  key={i}
                  transform={`rotate(${i * 30} ${x} ${y})`}
                  d={`M${x + r + 10} ${y - 8}h18v16h-18`}
                />
              ))}
            </g>
          ))}
          {[
            [310, 240],
            [680, 320],
            [400, 760],
            [2060, 310],
            [1810, 680],
            [790, 130],
            [1760, 800],
          ].map(([x, y]) => (
            <g key={`${x}-${y}`}>
              <circle cx={x} cy={y} r="7" />
              <circle cx={x} cy={y} r="17" />
              <path d={`M${x - 30} ${y}h13m34 0h13M${x} ${y - 30}v13m0 34v13`} />
            </g>
          ))}
          {[
            [170, 600],
            [620, 220],
            [1880, 180],
            [2210, 730],
            [680, 790],
          ].map(([x, y]) => (
            <g key={x} transform={`translate(${x} ${y})`}>
              <path d="M0-24V24M-14-14L0 0 14-14M-14 14L0 0 14 14M-23-30H23M-23 30H23" />
              <circle r="38" strokeDasharray="8 9" />
            </g>
          ))}
        </g>
        <g className="forge-etch-energy" strokeWidth="2">
          <path d="M0 240H310L390 320H680L810 450H1080" />
          <path d="M2400 790H2130L2020 680H1810L1690 560" />
          <path d="M2400 310H2060L1980 390H1770L1630 530H1350" />
        </g>
      </g>
    </svg>
  );
}
