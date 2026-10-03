# 随包地理资料

基础陆地、河流与城市坐标来自 Natural Earth 公共领域地理数据。地图属于当代导航参考，不代表历史海岸、行政边界或城市位置已被历史考证。城市的中文名称与常见旧名用于候选检索；同名与历史迁址仍由用户选择，不自动合并身份。

- land.geojson：Natural Earth land（沿用下载源的真实地形几何）。
- rivers.geojson：Natural Earth rivers/lake centerlines。
- places.json：Natural Earth ne_10m_populated_places_simple 中 min_zoom ≤ 6 及补充常用中文地名，保留 ne_id 作为种子身份。
- place-names-zh.js：按 NE_ID 对应完整 Natural Earth 数据的 NAME_ZH，覆盖随包 2,524 个地点；原名仍可搜索。显示层同时适用于已有工作空间，不改写地点修订、坐标、历史引用或自定义地点。
- vendor/d3.min.js：D3 7.9.0，ISC License。

基础地点仅供导航，不创建记录，不驱散任何时间层的迷雾。中文别名仅是检索线索，不表达所有时期地理等同。未找到的地点可创建为地区、聚落、自然地理或自定义文本归属。

来源：https://www.naturalearthdata.com/ （Public Domain），https://d3js.org/ ，https://github.com/d3/d3/blob/main/LICENSE （ISC）。

地图资源全部本地提供，应用启动与记录不依赖外网地图服务。资源读取失败时，文字地点选择继续工作。

中文名称来源：[Natural Earth 完整城市数据](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_10m_populated_places.geojson)，数据 blob SHA `376fb028c390a7a23213800ae4babaa6f534a0f3`。维护时下载完整 GeoJSON 后运行 `node features/atlas/data/prepare-names.mjs <文件路径>`，生成前会检查每个种子身份与汉字覆盖率。不要按英文名称合并同名城市。国家名称用标准 ISO 代码对应中文显示；行政区原始字段保留在数据中。
