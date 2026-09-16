# web-isdb-t-viewer

<img width="800" alt="receive_example" src="https://github.com/user-attachments/assets/0e04bb71-146a-42f8-b3c7-5234d479b35d" />

A browser-based ISDB-T One-Seg TV receiver for RTL-SDR.

It connects directly to an RTL-SDR dongle using WebUSB, demodulates Japanese One-Seg (1seg) terrestrial digital TV signals in the browser, and plays the live MPEG-TS stream through Media Source Extensions.

No native SDR software is required — the entire receiving, demodulation, and playback pipeline runs locally in the browser.

RTL-SDRを使用した、ブラウザベースのISDB-Tワンセグ受信ソフトウェアです。

WebUSBを利用してブラウザからRTL-SDRへ直接アクセスし、日本のワンセグ（1seg）地上デジタルテレビ放送をブラウザ内で復調してライブ再生します。

ソフトウェアをインストールする必要はなく、受信・復調・再生までをブラウザ上で完結できます。

## Acknowledgements

This project was developed with reference to the [gr-isdbt](https://github.com/git-artes/gr-isdbt) project, which served as a valuable reference for understanding and implementing ISDB-T signal processing.
