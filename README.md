# Rail Inspection 3D Map — Drone × AI (Concept Demo)

Khung xử lý **video/ảnh drone → mô hình 3D → phát hiện hư hỏng → gắn vị trí (キロ程) → đánh giá rủi ro → bản đồ 3D**, giúp kỹ sư và quản lý thấy ngay **đoạn đường sắt nào đang có vấn đề** để can thiệp kịp thời.

Demo dùng tuyến **JR山手線 (Tokyo)**, 34,5 km, 30 ga. Hình học tuyến lấy thật từ OpenStreetMap. **Toàn bộ dữ liệu kiểm tra (hư hỏng, ảnh, điểm 3D) là dữ liệu giả lập** vì hiện chưa có video drone thật.

```
撮る (Drone)  →  見つける (AI)  →  理解する (History / 3D)  →  判断する (Risk / Priority)
```

---

## 1. Chạy demo

- Mở trực tiếp `viewer/index.html` bằng Chrome/Edge (double-click là được, không cần server). Cần có internet để tải bản đồ nền và thư viện.
- Nếu muốn chạy qua server: `npx serve viewer` hoặc `python -m http.server -d viewer 8000`.
- Link trực tiếp tới một màn hình (dùng khi trình bày):
  - `index.html?defect=D-0001`: vết nứt AA ở cầu cạn gạch 有楽町〜新橋
  - `index.html?section=JY-S068&campaign=2025`: đoạn cầu thép 神田川, đợt kiểm tra 2025
  - Vị trí camera được lưu trên URL (`#zoom/lat/lon/bearing/pitch`), copy URL là chia sẻ được đúng góc nhìn.

**Tạo lại dữ liệu demo** (sau khi sửa `data/demo_scenario.json`):
```powershell
powershell -ExecutionPolicy Bypass -File tools\build_demo_data.ps1
```

### Màn hình gồm gì

| Khu vực | Nội dung |
|---|---|
| Bản đồ 3D | Tuyến được chia thành **173 đoạn × 200 m**, tô màu theo mức rủi ro. Cột 3D tại mỗi hư hỏng, chiều cao thể hiện mức rủi ro. Có đường bay drone, nhà 3D và nhãn ga. |
| Cột trái | Trạng thái **pipeline 6 bước**, các chỉ số KPI (要対応 / 計画補修 / 新規検出 / 進行あり), **danh sách ưu tiên** sắp theo rủi ro |
| Panel phải | Chi tiết hư hỏng: **frame drone + bounding box AI**, giá trị đo, **xu hướng qua 3 năm**, phân rã rủi ro, đề xuất xử lý (AI提案), nút 技術者確認 / 作業指示, **point cloud 3D** của kết cấu |
| Dải キロ程 | Sơ đồ tuyến tính 0–34,5 km kiểu kỹ sư đường sắt hay dùng; click để bay tới đoạn tương ứng |
| Thanh trên | Chọn đợt kiểm tra 2024 / 2025 / 2026, **前回比較** (tô màu theo mức thay đổi so với lần trước), bật/tắt đường bay và nhà 3D |

Mức đánh giá dùng thang **健全度 AA / A1 / A2 / B / C / S**, là thang quen thuộc với kỹ sư kết cấu đường sắt Nhật. Thang này chỉ là **đề xuất của AI**; kỹ sư là người quyết định cuối cùng.

---

## 2. Kịch bản demo khoảng 5 phút (cho buổi họp 26/11)

1. **Toàn tuyến (撮る→見つける)**: đang ở 2026. Màu xanh là bình thường, đỏ/cam là đoạn cần chú ý. Cột trái cho thấy dữ liệu đi qua pipeline thế nào (18 video → 10k keyframe → 3D → AI → キロ程).
2. **Danh sách ưu tiên**: click mục AA *ひび割れ・アーチ部* (有楽町〜新橋). Camera bay vào cầu cạn gạch, panel phải hiện ảnh drone kèm bounding box và point cloud.
3. **Lịch sử (理解する)**: biểu đồ cho thấy vết nứt dài 5 → 8 → 14 cm và rộng 0.2 → 0.7 mm, tốc độ phát triển đang tăng. Chuyển qua lại 2024 / 2025 / 2026 ở thanh trên.
4. **前回比較**: bật lên để thấy toàn tuyến chỉ còn vài đoạn xấu đi rõ rệt. Đây là thứ quản lý cần xem.
5. **Ra quyết định (判断する)**: rủi ro = mức nghiêm trọng × tầm quan trọng của cấu kiện + tốc độ phát triển → 健全度 đề xuất → 作業指示. Sau đó hỏi phía Nhật: *「現場の技術者にとって、どのような情報が返ってくると一番使いやすいでしょうか？」*

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
 │ 4 detect       YOLO-seg (7 classes), tiled for thin cracks                   │
 │ 5 localize     ray-cast → 3D point, multi-view fusion, キロ程, stable ID      │
 │ 6 assess       severity, component, history merge                            │
 │ 7 export       inspection.js (viewer) + GeoJSON + CSV                        │
 └──────────────────────────────────┬─────────────────────────────────────────┘
                                    ▼  rail-inspection/0.1 schema
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
| 6 Assess | defects + lịch sử → severity | Ngưỡng theo 維持管理標準 (cần hiệu chỉnh cùng kỹ sư) | Tiêu chí 健全度 thực tế họ đang áp dụng |
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
Line (JY) ─ Section (200 m, km from/to, asset) ─ Component (橋脚/桁/擁壁/架線柱…, criticality)
                                                   └─ Defect (ID ổn định qua các năm)
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
│  └─ data/rail_line.js     Tuyến + ga (từ OSM)
│     data/inspection.js    Kết quả kiểm tra (hiện là MOCK)
├─ pipeline/                Khung xử lý Python, 7 bước
│  ├─ run.py, core.py, geo.py, config.example.yaml, requirements.txt
│  └─ stages/s1_ingest.py … s7_export.py
├─ tools/build_demo_data.ps1  Ghép tuyến OSM, chia đoạn, sinh dữ liệu demo
└─ data/
   ├─ raw/osm_yamanote_*.json        Dữ liệu OSM gốc (ODbL)
   ├─ demo_scenario.json             Kịch bản demo + danh mục hư hỏng/kết cấu/健全度
   └─ assets_register.sample.json    Mẫu 構造物台帳 (km → loại kết cấu)
```

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

- **Dữ liệu kiểm tra là giả lập**: vị trí, kích thước hư hỏng, ảnh frame (SVG) và point cloud đều được sinh tự động để minh hoạ. Loại kết cấu theo khu vực (高架橋, 橋梁…) chỉ mang tính tượng trưng.
- **Pipeline Python mới là khung**: chưa được chạy end-to-end vì chưa có dữ liệu thật và máy này chưa cài Python. Bước 3 mặc định `dry_run`; bước 4 mặc định dùng `MockDetector`; ngưỡng severity là placeholder.
- Bước 5 hiện định vị gần đúng bằng pose GNSS và một mô hình phẳng của kết cấu. Bản production nên ray-cast trên mesh với pose đã tinh chỉnh bởi SfM.
- Viewer chưa hiển thị mesh/3D Tiles thật. Khi có output ODM, chỉ cần thêm `Tile3DLayer` của deck.gl.
- Bản đồ nền © OpenFreeMap / OpenMapTiles / OpenStreetMap contributors. Tuyến đường sắt © OpenStreetMap contributors (ODbL).
