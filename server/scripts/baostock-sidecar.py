# -*- coding: utf-8 -*-
"""
Baostock sidecar（一次性进程，JSON over stdin/stdout）
====================================================================
为什么存在：Baostock 是 Python-only 库，Node 服务通过本脚本按需拉取它独有的
数据（指数**历史**成分——含其后退市证券，修复幸存者偏差的最后一块）。
与此前 2026-09-09 的决策一致：sidecar 仅在需要 Python 独有数据时按需启用。

协议（极简，一次性进程，无常驻状态）：
  - stdin 传入一行 JSON 请求：{"index": "hs300"|"zz500"|"sz50", "date": "YYYY-MM-DD"?}
  - stdout 输出一行 JSON 响应：
      成功 {"ok":true,"index":...,"requestedDate":...,"updateDate":"2024-06-24",
            "count":300,"constituents":[{"code":"600000","name":"浦发银行"},...]}
      失败 {"ok":false,"error":"人类可读原因"}（退出码仍为 0——协议内错误也是
           正常响应；只有 Python 崩溃/未安装才会让 Node 拿不到 JSON）
  - baostock 的 login/logout 打印与全部第三方噪声重定向到 stderr，
    stdout 上只允许出现最终那行 JSON。

字段口径（2026-09-12 实测）：
  - query_hs300_stocks(date="2024-06-28") → fields=['updateDate','code','code_name']，
    300 行；date 传任意日期，返回该日期之前最近一次调仓的成分快照
    （实测传 2024-06-28 返回 updateDate=2024-06-24 的名单）；
  - code 为 "sh.600000" / "sz.000001" 格式，此处归一为 6 位数字码；
  - **历史快照含其后退市的证券**（实测 2015-06-30 成分含已于 2016 年退市的武钢股份
    sh.600005）——这正是它对幸存者偏差的价值，也是东财/Tushare 免费通道都给不了的。
"""
import contextlib
import json
import os
import sys
import tempfile

INDEX_QUERIES = {
    "hs300": "query_hs300_stocks",
    "zz500": "query_zz500_stocks",
    "sz50": "query_sz50_stocks",
}


def respond(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
        index = str(req.get("index", "")).strip().lower()
        if index not in INDEX_QUERIES:
            raise ValueError("不支持的指数：%s（可选 hs300/zz500/sz50）" % index)
        date = req.get("date")
        if date is not None:
            date = str(date).strip()
            if date and len(date) != 10:
                raise ValueError("date 需为 YYYY-MM-DD 格式（当前：%s）" % date)

        # baostock 会在 cwd 附近写运行日志：chdir 到临时目录，避免污染仓库/服务目录
        workdir = os.path.join(tempfile.gettempdir(), "baostock-sidecar")
        os.makedirs(workdir, exist_ok=True)
        os.chdir(workdir)

        import baostock as bs

        with contextlib.redirect_stdout(sys.stderr):
            lg = bs.login()
            if lg.error_code != "0":
                raise RuntimeError("baostock 登录失败 [%s] %s" % (lg.error_code, lg.error_msg))
            try:
                query = getattr(bs, INDEX_QUERIES[index])
                rs = query(date=date) if date else query()
                rows = []
                while rs.next():
                    rows.append(rs.get_row_data())
                fields = list(rs.fields)
                err_code, err_msg = rs.error_code, rs.error_msg
            finally:
                bs.logout()
        if err_code != "0":
            raise RuntimeError("%s 失败 [%s] %s" % (INDEX_QUERIES[index], err_code, err_msg))

        iu, ic, inm = fields.index("updateDate"), fields.index("code"), fields.index("code_name")
        constituents = []
        for r in rows:
            code = str(r[ic]).split(".")[-1]
            if len(code) == 6 and code.isdigit():
                constituents.append({"code": code, "name": (r[inm] or None)})
        update_date = rows[0][iu] if rows else None
        respond(
            {
                "ok": True,
                "index": index,
                "requestedDate": date or None,
                "updateDate": update_date,
                "count": len(constituents),
                "constituents": constituents,
            }
        )
    except Exception as exc:  # 协议内错误：JSON 化，退出码 0
        respond({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
