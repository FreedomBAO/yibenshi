"""Offline layout proof, deliberately ineligible for upload/publication."""
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw
from .models import Draft
from .pdf import render, chinese_count
from .client import save


def fixture():
    mechanism = "先把模糊目标拆成能够观察的行为，再记录行为发生的环境和结果。记录并不证明因果关系，它只是帮助我们发现值得继续验证的线索。每次只改变一个条件，给自己留出反思空间。"
    case = "这是用于测试排版的合成情境：小林准备学习新技能，他先在纸上列出时间安排，完成后记录实际花费，再比较计划和结果。这个情境不代表真实研究结论，也不证明某种方法适用于所有人。"
    insights = []
    for i in range(5):
        insights.append({"title": f"测试洞见{i + 1}：把行动变成记录", "judgment": "让每次行动留下可以回看的记录。",
                         "mechanism": mechanism * 3, "boundary": "这只是合成排版样稿，不能作为现实决策建议。",
                         "examples": [{"type": "合成情境", "text": case * 2, "source_ids": []} for _ in range(2)],
                         "sop": {"trigger": "准备开始一次学习实验时", "inputs": "纸笔和十五分钟时间",
                                 "steps": ["写出本次可完成的一项动作，并明确如何判断完成。", "记录当前情境与可投入时间，不把推测当作事实。", "执行动作后留下结果，注明发生偏差的具体位置。", "比较计划和结果，选择是否继续，不夸大一次观察的价值。"],
                                 "output": "一份带日期的实验记录", "stop": "发现明显不适或资源不足时停止并寻求帮助。"},
                         "question": "如果需要复盘，你能找到一条明确记录吗？"})
    return Draft.model_validate({"title": "离线排版测试：行动与复盘", "originalTitle": "Offline Layout Fixture", "author": "测试样稿",
                                 "description": mechanism + "这是用于检验中文字体、页数、边距和文本提取的测试样稿，不会上传，也不构成正式图书导读。",
                                 "tags": ["测试", "排版", "样稿"], "category": "测试", "value": "仅用于检查云端PDF生成流程。",
                                 "reading_map": mechanism, "insights": insights, "plan": [mechanism for _ in range(7)],
                                 "criticism": mechanism * 2, "copyright": "本文为离线排版测试样稿，不是原书替代品；建议支持正版并结合原书阅读。",
                                 "claims": [{"text": "这是测试内容", "source_ids": ["fixture"]} for _ in range(5)]})


def main():
    output = Path("_cloud_daily_work/offline-proof")
    d = fixture()
    pdf, images, pages = render(d, output)
    sheet = Image.new("RGB", (1000, 1420), "#ddd")
    for i, path in enumerate(images):
        with Image.open(path) as image:
            thumb = ImageOps.contain(image.convert("RGB"), (240, 340))
            sheet.paste(thumb, ((i % 4) * 250, (i // 4) * 355))
    sheet.save(output / "contact-sheet.jpg")
    save(output / "state.json", {"fixture": True, "stage": "offline_layout_only", "pages": len(pages),
                                 "chineseCharacters": chinese_count(d), "prepublishPassed": False, "passed": False})
    print(f"Offline PDF proof: {pdf}; {len(pages)} rendered pages. Not eligible for publication.")


if __name__ == "__main__":
    main()
