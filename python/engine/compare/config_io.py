"""方案（列映射模板）的存取格式。

用途：配好一组文件后把「字段角色 + 各对比表列映射 + 容差」存成方案；
下次换同结构文件一键载入，省掉每次重新选列。
映射按【文件名】匹配，因此载入时只要当前已上传同名文件即可复用。

对外只暴露一个值对象 Plan，把「存取」与「套用」的字段集收在一处，避免手工对称：
  - Plan.from_tables(...)  把当前实例配好的一组文件收成方案（存盘用）
  - Plan.from_dict(cfg)    把存下来的方案读回来
  - plan.to_dict()         序列化成可落库的 dict
  - plan.apply_to(...)     套回当前文件，返回 Applied（含显式的 matched）
"""
from __future__ import annotations

from dataclasses import dataclass

PLAN_VERSION = 2


@dataclass(frozen=True)
class Applied:
    """方案套回当前文件后的结果。

    matched=False 表示主表名对不上、整套方案都没生效 —— 容差是业务口径，跟着主表走，
    不能张冠李戴。这条规则做成显式属性，调用方一眼可见，而不是藏在返回值里。
    """

    matched: bool
    primary_fields: list[dict]
    others: list[dict]
    tolerance: float


@dataclass(frozen=True)
class Plan:
    primary: str | None
    tolerance: float | None
    primary_fields: list[dict]
    others: list[dict]

    @classmethod
    def from_tables(cls, primary, primary_fields, others, tolerance) -> "Plan":
        """从当前实例的一组文件生成方案（对应原来的 dump_config）。"""
        return cls(
            primary=primary["name"] if primary else None,
            tolerance=tolerance,
            primary_fields=[
                {"name": f["name"], "role": f["role"], "type": f.get("type", "text")}
                for f in primary_fields
            ],
            others=[
                {"name": o["table"]["name"], "maps": dict(o.get("maps", {}))}
                for o in others
            ],
        )

    @classmethod
    def from_dict(cls, cfg: dict) -> "Plan":
        """从落库的方案快照还原（字段缺失时宽容读取，与旧格式一致）。"""
        return cls(
            primary=cfg.get("primary"),
            tolerance=cfg.get("tolerance"),
            primary_fields=list(cfg.get("primary_fields", [])),
            others=list(cfg.get("others", [])),
        )

    def to_dict(self) -> dict:
        return {
            "version": PLAN_VERSION,
            "primary": self.primary,
            "tolerance": self.tolerance,
            "primary_fields": self.primary_fields,
            "others": self.others,
        }

    def apply_to(self, primary, primary_fields, others, tolerance) -> Applied:
        """把方案应用到当前已加载的文件。

        匹配规则：主表按文件名；对比表按文件名，再按 A 字段名 -> 列名 回填映射。
        主表名对不上时整套方案都不生效 —— 容差是业务口径，跟着主表走，不能张冠李戴。
        """
        matched = bool(primary and self.primary == primary["name"])

        new_fields = []
        if matched:
            # 以配置为主，按 A 列名匹配（保留 A 当前实际列名作为字段名）
            for col in primary["columns"]:
                cf = next((f for f in self.primary_fields if f["name"] == col), None)
                if cf:
                    new_fields.append({
                        "name": col,
                        "role": cf.get("role", "compare"),
                        "type": cf.get("type", "text"),
                    })
        else:
            new_fields = list(primary_fields)

        new_others = []
        for o in others:
            nm = o["table"]["name"]
            co = next((x for x in self.others if x.get("name") == nm), None)
            maps = {f["name"]: None for f in new_fields}
            if co:
                for aname, col in co.get("maps", {}).items():
                    if aname in maps and col in o["table"]["columns"]:
                        maps[aname] = col
            new_others.append({"table": o["table"], "maps": maps})

        new_tol = self.tolerance if (matched and self.tolerance is not None) else tolerance
        if not isinstance(new_tol, (int, float)):
            new_tol = tolerance
        return Applied(matched, new_fields, new_others, new_tol)
