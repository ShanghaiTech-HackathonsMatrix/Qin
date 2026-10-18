/**
 * 弹层右上角那个「关闭」。
 *
 * 原来是一个写着「关闭」两个字的按钮，七个弹层各写一遍，字号一调大就把
 * 标题挤走。现在统一成**黑色圆底 + 白色叉**：图标占的位置跟字号无关，
 * 一眼就能认出来，也不用再为「关闭」这两个字留宽度。
 *
 * 必须 `type="button"`：好几个弹层本身就是 `<form>`，默认的 submit 类型
 * 会顺手把表单交出去。
 */
interface Props {
  onClick: () => void;
  /** 读屏用的名字。图标本身没有文字 */
  label?: string;
}

export default function CloseButton({ onClick, label = '关闭' }: Props) {
  return (
    <button type="button" className="close-x" aria-label={label} title={label} onClick={onClick}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.3 4.3 11.7 11.7M11.7 4.3 4.3 11.7" />
      </svg>
    </button>
  );
}
