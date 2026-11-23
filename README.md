# Rail Inspection 3D Map — Drone × AI (Concept Demo)

Khung xử lý **video/ảnh drone → mô hình 3D → phát hiện hư hỏng → gắn vị trí (キロ程) → đánh giá rủi ro → bản đồ 3D**, giúp kỹ sư và quản lý thấy ngay **đoạn đường sắt nào đang có vấn đề** để can thiệp kịp thời.

Demo có **3 tuyến ở 3 thành phố**, chọn ở ô chọn tuyến trên thanh trên cùng:

| Mã | Tuyến | Thành phố | Chiều dài | Ga | Ghi chú |
|---|---|---|---|---|---|
| `JY` | JR山手線 | 東京 Tokyo | 34,5 km (vòng) | 30 | Cầu cạn RC, cầu thép, nền đắp/đào |
| `O` | JR大阪環状線 | 大阪 Osaka | 21,8 km (vòng) | 19 | Cầu thép qua sông (安治川, 木津川, 大川, 寝屋川) |
| `AN` | あおなみ線 | 名古屋 Nagoya | 15,2 km (một chiều) | 11 | Chủ yếu cầu cạn RC, vùng ven biển (ăn mòn do muối) |

Hình học tuyến lấy thật từ OpenStreetMap. **Toàn bộ dữ liệu kiểm tra (hư hỏng, ảnh, điểm 3D) là dữ liệu giả lập** vì hiện chưa có video drone thật.

Hư hỏng chia làm 2 nhóm, lọc bằng nút **Show: All / Structure / Track** ở cột trái:
- **Structure (構造物)**: nứt, bong tróc, lộ cốt thép, ăn mòn, thấm nước, biến dạng, thiếu chi tiết. Toàn bộ cầu cạn là **bê tông cốt thép (RC)**.
- **Track (軌道)**: **xê dịch ray / sai lệch hình học (軌道変位, 通り・高低狂い)** đo từ point cloud trên dây cung 10 m, **nứt ray (レール亀裂, nghi shelling)**, **phụt bùn đá ba lát (道床噴泥)**, **nứt tà vẹt (まくらぎ割損)**, **mất phụ kiện liên kết ray (締結装置欠損)**.

```
撮る (Drone)  →  見つける (AI)  →  理解する (History / 3D)  →  判断する (Risk / Priority)
```

---

## 1. Chạy demo

- Mở trực tiếp `viewer/index.html` bằng Chrome/Edge (double-click là được, không cần server). Cần có internet để tải bản đồ nền và thư viện.
- Nếu muốn chạy qua server: `npx serve viewer` hoặc `python -m http.server -d viewer 8000`.
- Link trực tiếp tới một màn hình (dùng khi trình bày):
  - `index.html?line=JY&defect=D-0001`: vết nứt AA ở trụ cầu cạn RC 有楽町〜新橋
  - `index.html?line=JY&defect=D-0009`: **nứt ray** AA (上野〜御徒町), mới xuất hiện từ 2025
  - `index.html?line=JY&defect=D-0008`: **xê dịch ray** A1 (新宿〜代々木), 6 → 11 → 24 mm
  - `index.html?line=O&cat=track`: Osaka, chỉ hiện hư hỏng đường ray
  - `index.html?line=AN`: Nagoya あおなみ線
  - `index.html?line=JY&section=JY-S068&campaign=2025`: đoạn cầu thép 神田川, đợt kiểm tra 2025
  - Tham số: `line` (JY / O / AN), `defect`, `section`, `campaign`, `cat` (all / structure / track), `lang` (en / ja).
  - Vị trí camera được lưu trên URL (`#zoom/lat/lon/bearing/pitch`), copy URL là chia sẻ được đúng góc nhìn.

**Tạo lại dữ liệu demo** (sau khi sửa `data/demo_scenario.json`):
```powershell
powershell -ExecutionPolicy Bypass -File tools\build_demo_data.ps1
```

### Màn hình gồm gì

| Khu vực | Nội dung |
|---|---|
| Bản đồ 3D | Tuyến được chia thành **các đoạn × 200 m** (山手線: 173 đoạn), tô màu theo mức rủi ro. Cột 3D tại mỗi hư hỏng, chiều cao thể hiện mức rủi ro. Có đường bay drone, nhà 3D và nhãn ga. |
| Cột trái | Trạng thái **pipeline 6 bước**, bộ lọc **All / Structure / Track**, các chỉ số KPI (要対応 / 計画補修 / 新規検出 / 進行あり), **danh sách ưu tiên** sắp theo rủi ro |
| Panel phải | Chi tiết hư hỏng: **frame drone + bounding box AI**, giá trị đo, **xu hướng qua 3 năm**, phân rã rủi ro, đề xuất xử lý (AI提案), nút 技術者確認 / 作業指示, **point cloud 3D** của kết cấu |
| Dải キロ程 | Sơ đồ tuyến tính 0–34,5 km kiểu kỹ sư đường sắt hay dùng; click để bay tới đoạn tương ứng |
| Thanh trên | **Chọn tuyến (Tokyo / Osaka / Nagoya)**, chọn đợt kiểm tra 2024 / 2025 / 2026, **前回比較** (tô màu theo mức thay đổi so với lần trước), bật/tắt đường bay và nhà 3D |

Mức đánh giá dùng thang **健全度 AA / A1 / A2 / B / C / S**, là thang quen thuộc với kỹ sư kết cấu đường sắt Nhật. Thang này chỉ là **đề xuất của AI**; kỹ sư là người quyết định cuối cùng.

---

## 2. Kịch bản demo khoảng 5 phút (cho buổi họp 26/11)

1. **Toàn tuyến (撮る→見つける)**: đang ở 2026. Màu xanh là bình thường, đỏ/cam là đoạn cần chú ý. Cột trái cho thấy dữ liệu đi qua pipeline thế nào (18 video → 10k keyframe → 3D → AI → キロ程).
2. **Danh sách ưu tiên**: click mục AA *ひび割れ・橋脚* (有楽町〜新橋). Camera bay vào cầu cạn RC, panel phải hiện ảnh drone kèm bounding box và point cloud.
3. **Lịch sử (理解する)**: biểu đồ cho thấy vết nứt dài 5 → 8 → 14 cm và rộng 0.2 → 0.7 mm, tốc độ phát triển đang tăng. Chuyển qua lại 2024 / 2025 / 2026 ở thanh trên.
4. **Đường ray (軌道)**: bấm **Track**. Mở *レール亀裂* (上野〜御徒町, AA) và *軌道変位* (新宿〜代々木, A1): ảnh drone nhìn từ trên xuống cho thấy ray lệch khỏi đường thiết kế (nét đứt xanh), point cloud thể hiện đoạn ray bị cong (phóng đại).
5. **前回比較**: bật lên để thấy toàn tuyến chỉ còn vài đoạn xấu đi rõ rệt. Đây là thứ quản lý cần xem.
6. **Khả năng mở rộng**: đổi tuyến sang Osaka / Nagoya. Cùng một pipeline và một schema dữ liệu dùng cho mọi tuyến (ví dụ: dầm thép cầu 安治川 bị ăn mòn do môi trường cửa sông, gối cầu ven biển ở あおなみ線).
7. **Ra quyết định (判断する)**: rủi ro = mức nghiêm trọng × tầm quan trọng của cấu kiện + tốc độ phát triển → 健全度 đề xuất → 作業指示. Sau đó hỏi phía Nhật: *「現場の技術者にとって、どのような情報が返ってくると一番使いやすいでしょうか？」*

---

## 3. Kiến trúc

```
 ┌──────────── 現場 / Field ────────────┐
 │ Drone (4K video + .SRT GNSS, photos) │
 └──────────────────┬───────────────────┘
                    ▼  workspace/<campaign>/raw/<flight>/
 ┌──────────────────────────── pipeline/ (Python) ────────────────────────────┐
 │ 1 ingest       inventory media, parse DJI .SRT / XMP → GNSS per frame        │
 │ 2 keyframes    sample every ~1.5 m, drop blurred frames → geo.txt            │
 │ 3 reconstruct  OpenDroneMap (SfM/MVS) → point cloud, mesh, ortho, 3D Tiles   │
 │ 4 detect       YOLO-seg (structure + track classes), tiled for thin cracks   │
 │ 5 localize     ray-cast → 3D point, multi-view fusion, キロ程, stable ID      │
 │ 6 assess       severity, component, history merge                            │
 │ 7 export       inspection.js (viewer) + GeoJSON + CSV                        │
 └──────────────────────────────────┬─────────────────────────────────────────┘
                                    ▼  rail-inspection/0.2 schema
 ┌──────────────── viewer/ (MapLibre GL + deck.gl) ────────────────┐
 │ 3D map · km strip · priority list · defect detail · trends      │
 └─────────────────────────────────────────────────────────────────┘
```

| Bước | Đầu vào → Đầu ra | Công nghệ (đề xuất cho PoC) | Cần xác nhận với phía Nhật |
|---|---|---|---|
| 1 Ingest | MP4/MOV + .SRT, JPG → `manifest.json` | FFmpeg, parse DJI SRT/XMP | Model drone? Có file .SRT không? RTK? |
| 2 Keyframes | video → keyframe JPG + `geo.txt` | OpenCV (lọc ảnh mờ bằng Laplacian, lấy mẫu theo khoảng cách) | Khoảng cách bay tới kết cấu, tốc độ bay, overlap |
| 3 3D | keyframes → LAZ, mesh, 3D Tiles | **OpenDroneMap** (mã nguồn mở); có thể thử COLMAP, Metashape, RealityCapture | Có GCP không? Cần độ chính xác cm hay chỉ cần định vị? |
| 4 Detect | keyframes → `detections.json` | YOLOv8/11-seg, cắt ảnh thành tile (SAHI) | **Dữ liệu đã gán nhãn?** Danh mục hư hỏng họ dùng |
| 5 Localize | detections → defects 3D + km | Ray-cast theo pose → mesh (trimesh/Open3D), linear referencing | Hệ キロ程 chính thức, 構造物台帳 |
| 6 Assess | defects + lịch sử → severity | Ngưỡng theo 維持管理標準 (cần hiệu chỉnh cùng kỹ sư). **軌道変位** tính từ point cloud: trích tâm ray → độ võng trên dây cung 10 m | Tiêu chí 健全度 và ngưỡng 軌道整備基準値 họ đang áp dụng; drone có được bay trên ray (nadir) không |
| 7 Export | → viewer / GIS / Excel | JSON, GeoJSON, CSV (UTF-8 BOM) | Hệ thống quản lý tài sản đang dùng |

Pipeline chạy được từng bước độc lập. Ví dụ khi đổi model AI chỉ cần chạy lại từ bước 4, không phải dựng 3D lại:
```bash
pip install -r pipeline/requirements.txt
python -m pipeline.run --list
python -m pipeline.run --config pipeline/config.example.yaml --campaign 2026
python -m pipeline.run --config pipeline/config.example.yaml --campaign 2026 --stages detect,localize,assess,export
```

### Data model (ontology)

```
Line (JY/O/AN) ─ Section (200 m, km from/to, asset) ─ Component (橋脚/桁/擁壁/架線柱/レール/道床…, criticality)
                                                   └─ Defect (ID ổn định qua các năm, cat = structure | track)
                                                        └─ Observation / Campaign (sev, size, conf, frame)
                                                             └─ Detection (bbox/mask trong từng frame)
Campaign ─ Flight ─ Media ─ Frame                 WorkOrder ← Defect (sau khi kỹ sư xác nhận)
```
Điểm mấu chốt là **Defect ID không đổi qua các đợt kiểm tra** (bước 5). Nhờ vậy mới có xu hướng xuống cấp (Phase 2) và độ ưu tiên bảo trì (Phase 3). Cấu trúc này map thẳng sang Palantir Ontology (Object types và Links) khi cần.

### Công thức rủi ro (bản PoC)
```
risk = 0.8 × severity × (0.6 + 0.4 × criticality) + 0.2 × growth
grade: ≥0.85 AA · ≥0.70 A1 · ≥0.50 A2 · ≥0.30 B · ≥0.15 C · else S
```

---

## 4. Cấu trúc thư mục

```
3d-map/
├─ viewer/                  Web 3D map (không cần build)
│  ├─ index.html, style.css, app.js
│  └─ data/lines.js               Danh sách tuyến
│     data/<JY|O|AN>/rail_line.js  Tuyến + ga (từ OSM)
│     data/<JY|O|AN>/inspection.js Kết quả kiểm tra (hiện là MOCK)
├─ pipeline/                Khung xử lý Python, 7 bước
│  ├─ run.py, core.py, geo.py, config.example.yaml, requirements.txt
│  └─ stages/s1_ingest.py … s7_export.py
├─ tools/build_demo_data.ps1  Ghép tuyến OSM, chia đoạn, sinh dữ liệu demo cho mọi tuyến
└─ data/
   ├─ raw/osm_*.json                 Dữ liệu OSM gốc (ODbL): yamanote, osaka_loop, aonami
   ├─ demo_scenario.json             Danh mục hư hỏng/kết cấu/健全度 + kịch bản từng tuyến
   └─ assets_register/<id>.sample.json  Mẫu 構造物台帳 (km → loại kết cấu)
```

**Thêm một tuyến mới**: tải relation OSM (`out geom`) và các node `stop` vào `data/raw/`, thêm một mục vào `lines` trong `data/demo_scenario.json` (vùng kết cấu dùng `from`/`to` hoặc `between` + `t`), rồi chạy lại `tools\build_demo_data.ps1`.

---

## 5. Checklist dữ liệu drone (hỏi trong buổi họp)

1. **Thiết bị và định dạng**: model drone/camera, 4K hay FHD, fps, có file `.SRT` (GNSS theo từng frame) không, có RTK không
2. **Cách bay**: khoảng cách tới kết cấu, độ cao, góc gimbal, bay một bên hay hai bên, thời gian mỗi chuyến, bay ban đêm hay vào giờ không chạy tàu
3. **Cách quay**: theo thứ tự 全景 → 部材単位 → 近接 → 損傷箇所 → detail shot; lặp lại cùng route mỗi năm (quan trọng để so sánh thay đổi)
4. **Dữ liệu sẵn có**: video/ảnh các năm trước, biên bản kiểm tra (点検調書), 構造物台帳, dữ liệu đã gán nhãn hư hỏng
5. **Output mong muốn**: kỹ sư hiện trường cần nhận thông tin gì, ở dạng nào (bản đồ, danh sách, Excel, PDF 調書)
6. **Chia sẻ dữ liệu**: phạm vi được chia sẻ sau 社内承認, nơi lưu trữ (on-prem/cloud), yêu cầu bảo mật

## 6. Roadmap PoC

| Phase | Mục tiêu | Thành phẩm |
|---|---|---|
| 1 Drone × AI | Chứng minh AI hiểu được video drone của họ | Keyframe + detect + kỹ sư kiểm chứng trên viewer (precision/recall) |
| 2 AI × History | So sánh qua nhiều năm | Defect ID tracking, change detection, biểu đồ xu hướng |
| 3 AI × Asset Mgmt | Từ kết quả kiểm tra đến quyết định bảo trì | Risk/priority, 作業指示, kết nối hệ thống quản lý tài sản |

## 7. Giới hạn hiện tại

- **Dữ liệu kiểm tra là giả lập**: vị trí, kích thước hư hỏng, ảnh frame (SVG) và point cloud đều được sinh tự động để minh hoạ. Loại kết cấu theo khu vực (高架橋, 橋梁…) và tên cầu có ghi （仮） chỉ mang tính tượng trưng, không phải dữ liệu chính thức.
- Ga 名古屋競馬場前 của あおなみ線 đã đổi tên thành 港北 (2022); demo dùng tên mới theo OSM.
- **Pipeline Python mới là khung**: chưa được chạy end-to-end vì chưa có dữ liệu thật và máy này chưa cài Python. Bước 3 mặc định `dry_run`; bước 4 mặc định dùng `MockDetector`; ngưỡng severity là placeholder.
- Bước 5 hiện định vị gần đúng bằng pose GNSS và một mô hình phẳng của kết cấu. Bản production nên ray-cast trên mesh với pose đã tinh chỉnh bởi SfM.
- Viewer chưa hiển thị mesh/3D Tiles thật. Khi có output ODM, chỉ cần thêm `Tile3DLayer` của deck.gl.
- Bản đồ nền © OpenFreeMap / OpenMapTiles / OpenStreetMap contributors. Tuyến đường sắt © OpenStreetMap contributors (ODbL).
